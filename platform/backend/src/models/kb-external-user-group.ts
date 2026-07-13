// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { and, eq, inArray, notExists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import db, { schema } from "@/database";
import { buildGroupToken, normalizeEmail } from "@/knowledge-base/acl-tokens";
import type { AclEntry, InsertKbExternalUserGroup } from "@/types";

/**
 * Snapshot of upstream group memberships for `auto-sync-permissions` connectors.
 * The permission-sync pass owns writes here via the mark-stale → upsert →
 * delete-stale cycle; the query path reads it (local join, no upstream call) to
 * resolve a user's `group:` tokens.
 */
class KbExternalUserGroupModel {
  /**
   * Lean projection of the current membership snapshot for one connector,
   * used by the permission pass to diff the fresh enumeration against what is
   * stored — unchanged memberships then cost ZERO writes (the retired
   * mark-stale cycle rewrote every row every pass).
   */
  static async findMembershipSnapshotByConnector(connectorId: string): Promise<
    {
      groupId: string;
      externalAccountId: string;
      memberEmail: string | null;
      displayName: string | null;
      accountType: string | null;
    }[]
  > {
    const t = schema.kbExternalUserGroupsTable;
    return await db
      .select({
        groupId: t.groupId,
        externalAccountId: t.externalAccountId,
        memberEmail: t.memberEmail,
        displayName: t.displayName,
        accountType: t.accountType,
      })
      .from(t)
      .where(eq(t.connectorId, connectorId));
  }

  /**
   * Upsert a batch of new or CHANGED memberships (the pass diffs first, so
   * unchanged rows never reach this). A re-upsert refreshes the email/display
   * name, so a member whose email BECOMES visible upstream starts resolving
   * on the next pass.
   */
  static async upsertMany(rows: InsertKbExternalUserGroup[]): Promise<void> {
    if (rows.length === 0) return;

    await db
      .insert(schema.kbExternalUserGroupsTable)
      .values(
        rows.map((row) => ({
          ...row,
          memberEmail: row.memberEmail ? normalizeEmail(row.memberEmail) : null,
        })),
      )
      .onConflictDoUpdate({
        target: [
          schema.kbExternalUserGroupsTable.connectorId,
          schema.kbExternalUserGroupsTable.groupId,
          schema.kbExternalUserGroupsTable.externalAccountId,
        ],
        set: {
          stale: false,
          memberEmail: sql`excluded.member_email`,
          displayName: sql`excluded.display_name`,
          accountType: sql`excluded.account_type`,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Delete an explicit batch of revoked memberships (present in the stored
   * snapshot, absent from a COMPLETED enumeration — completion-gated by the
   * caller, so an interrupted run never wrongly drops a membership).
   */
  static async deleteByKeys(params: {
    connectorId: string;
    keys: { groupId: string; externalAccountId: string }[];
  }): Promise<number> {
    if (params.keys.length === 0) return 0;

    const t = schema.kbExternalUserGroupsTable;
    const tuples = sql.join(
      params.keys.map((key) => sql`(${key.groupId}, ${key.externalAccountId})`),
      sql`, `,
    );
    // RETURNING-based count: `rowCount` is driver-dependent (absent under the
    // PGlite test driver), and the caller reports this number as the pass's
    // membershipsRemoved stat.
    const result = await db
      .delete(schema.kbExternalUserGroupsTable)
      .where(
        and(
          eq(t.connectorId, params.connectorId),
          sql`(${t.groupId}, ${t.externalAccountId}) IN (${tuples})`,
        ),
      )
      .returning({ groupId: t.groupId });
    return result.length;
  }

  /**
   * Resolve the namespaced `group:` tokens a user is entitled to, across the
   * given auto-sync connectors, via a local join on member email (no upstream
   * call on the query hot path). The email is normalized to match the stored
   * `memberEmail`. Automatic matching always takes precedence: a manual
   * member override grants the membership's groups ONLY while the upstream
   * account does not resolve automatically — no user in the connector's org
   * carries the member's email (hidden email, or no matching account).
   */
  static async findGroupTokensForUser(params: {
    memberEmail: string;
    userId?: string;
    connectorIds: string[];
  }): Promise<AclEntry[]> {
    if (params.connectorIds.length === 0) return [];

    const t = schema.kbExternalUserGroupsTable;
    const o = schema.kbMemberOverridesTable;
    const c = schema.knowledgeBaseConnectorsTable;
    const emailMatch = eq(t.memberEmail, normalizeEmail(params.memberEmail));
    // Correlated per membership row: does the row's member email resolve to
    // an org member of the connector's organization? While it does, the
    // account is automatically assigned and any override is inert.
    // Cost note: the correlation re-evaluates users × members × connectors
    // per row the outer scan visits, but the outer scan is bounded by one
    // email's memberships, and results are served from the group-token cache
    // between permission-sync passes — recomputed once per invalidation, not
    // per query. Revisit with EXPLAIN if membership snapshots grow hot.
    const autoMatch = db
      .select({ one: sql`1` })
      .from(schema.usersTable)
      .innerJoin(
        schema.membersTable,
        eq(schema.membersTable.userId, schema.usersTable.id),
      )
      .innerJoin(c, eq(c.id, t.connectorId))
      .where(
        and(
          // lower(trim(...)) mirrors normalizeEmail (which produced the
          // stored memberEmail), so the comparison cannot diverge from the
          // write-side contract.
          sql`lower(trim(${schema.usersTable.email})) = ${t.memberEmail}`,
          eq(schema.membersTable.organizationId, c.organizationId),
        ),
      );
    const rows = await db
      .selectDistinct({
        connectorType: t.connectorType,
        groupId: t.groupId,
      })
      .from(t)
      .leftJoin(
        o,
        and(
          eq(o.connectorId, t.connectorId),
          eq(o.externalAccountId, t.externalAccountId),
        ),
      )
      .where(
        and(
          inArray(t.connectorId, params.connectorIds),
          params.userId
            ? or(
                emailMatch,
                and(eq(o.userId, params.userId), notExists(autoMatch)),
              )
            : emailMatch,
        ),
      );

    return rows.map((row) =>
      buildGroupToken({
        connectorType: row.connectorType,
        groupId: row.groupId,
      }),
    );
  }

  /**
   * The full membership snapshot for a connector, each row annotated with the
   * Archestra org member it resolves to at query time. Resolution is the same
   * join `findGroupTokensForUser` enforces with — the normalized-email join
   * first (automatic matching always wins), a manual member override only as
   * the fallback — so what this reports is exactly what access control does:
   * `user` is null when neither an org member's email nor an override matches
   * (including when the upstream hides the email — `memberEmail` null), and
   * the grant currently resolves to nobody.
   */
  static async findMembershipsWithUsersByConnector(params: {
    connectorId: string;
    organizationId: string;
  }): Promise<
    {
      groupId: string;
      externalAccountId: string;
      displayName: string | null;
      memberEmail: string | null;
      accountType: string | null;
      updatedAt: Date;
      user: { id: string; name: string } | null;
      /** How `user` resolved: manual admin mapping or the email join. */
      resolvedVia: "override" | "email" | null;
    }[]
  > {
    const t = schema.kbExternalUserGroupsTable;
    const o = schema.kbMemberOverridesTable;
    const overrideUsers = alias(schema.usersTable, "override_users");
    const overrideMembers = alias(schema.membersTable, "override_members");
    const rows = await db
      .select({
        groupId: t.groupId,
        externalAccountId: t.externalAccountId,
        displayName: t.displayName,
        memberEmail: t.memberEmail,
        accountType: t.accountType,
        updatedAt: t.updatedAt,
        userId: schema.usersTable.id,
        userName: schema.usersTable.name,
        memberId: schema.membersTable.id,
        overrideUserId: overrideUsers.id,
        overrideUserName: overrideUsers.name,
        overrideMemberId: overrideMembers.id,
      })
      .from(t)
      .leftJoin(
        schema.usersTable,
        // Same lower(trim(...)) = normalizeEmail contract as
        // findGroupTokensForUser — the listing must resolve exactly like the
        // query path or the Users tab would disagree with actual access.
        sql`lower(trim(${schema.usersTable.email})) = ${t.memberEmail}`,
      )
      .leftJoin(
        schema.membersTable,
        and(
          eq(schema.membersTable.userId, schema.usersTable.id),
          eq(schema.membersTable.organizationId, params.organizationId),
        ),
      )
      .leftJoin(
        o,
        and(
          eq(o.connectorId, t.connectorId),
          eq(o.externalAccountId, t.externalAccountId),
        ),
      )
      .leftJoin(overrideUsers, eq(overrideUsers.id, o.userId))
      .leftJoin(
        overrideMembers,
        and(
          eq(overrideMembers.userId, overrideUsers.id),
          eq(overrideMembers.organizationId, params.organizationId),
        ),
      )
      .where(eq(t.connectorId, params.connectorId))
      .orderBy(t.groupId, t.memberEmail, t.externalAccountId);

    return rows.map((row) => {
      // A matching user account only counts if it is a member of this org —
      // for the override exactly as for the email join, so an override to a
      // since-departed user reads (and enforces) as unresolved.
      const overrideUser =
        row.overrideMemberId &&
        row.overrideUserId &&
        row.overrideUserName !== null
          ? { id: row.overrideUserId, name: row.overrideUserName }
          : null;
      const emailUser =
        row.memberId && row.userId && row.userName !== null
          ? { id: row.userId, name: row.userName }
          : null;
      return {
        groupId: row.groupId,
        externalAccountId: row.externalAccountId,
        displayName: row.displayName,
        memberEmail: row.memberEmail,
        accountType: row.accountType,
        updatedAt: row.updatedAt,
        user: emailUser ?? overrideUser,
        resolvedVia: emailUser ? "email" : overrideUser ? "override" : null,
      };
    });
  }

  static async deleteByConnector(connectorId: string): Promise<number> {
    const result = await db
      .delete(schema.kbExternalUserGroupsTable)
      .where(eq(schema.kbExternalUserGroupsTable.connectorId, connectorId));
    return result.rowCount ?? 0;
  }
}

export default KbExternalUserGroupModel;
