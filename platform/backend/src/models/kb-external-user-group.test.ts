// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { KbExternalUserGroupModel } from "@/models";
import { describe, expect, test } from "@/test";

describe("KbExternalUserGroupModel", () => {
  test("upsertMany normalizes emails and findGroupTokensForUser resolves namespaced tokens", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "github",
      visibility: "auto-sync-permissions",
    });

    await KbExternalUserGroupModel.upsertMany([
      {
        organizationId: org.id,
        connectorId: connector.id,
        connectorType: "github",
        groupId: "eng",
        externalAccountId: "Alice@Example.com",
        memberEmail: "Alice@Example.com",
      },
      {
        organizationId: org.id,
        connectorId: connector.id,
        connectorType: "github",
        groupId: "ops",
        externalAccountId: "bob@example.com",
        memberEmail: "bob@example.com",
      },
    ]);

    const tokens = await KbExternalUserGroupModel.findGroupTokensForUser({
      memberEmail: " alice@example.com ",
      connectorIds: [connector.id],
    });

    expect(tokens.sort()).toEqual(["group:github_eng"]);
  });

  test("snapshot diff: deleteByKeys removes revoked memberships only", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "github",
      visibility: "auto-sync-permissions",
    });

    const seed = (groupId: string) => ({
      organizationId: org.id,
      connectorId: connector.id,
      connectorType: "github" as const,
      groupId,
      externalAccountId: "user@example.com",
      memberEmail: "user@example.com",
    });

    await KbExternalUserGroupModel.upsertMany([seed("eng"), seed("ops")]);

    // A fresh sync run re-observed only "eng": the stored snapshot diff names
    // ("ops", user) as revoked.
    const snapshot =
      await KbExternalUserGroupModel.findMembershipSnapshotByConnector(
        connector.id,
      );
    expect(snapshot.map((row) => row.groupId).sort()).toEqual(["eng", "ops"]);
    await KbExternalUserGroupModel.deleteByKeys({
      connectorId: connector.id,
      keys: [{ groupId: "ops", externalAccountId: "user@example.com" }],
    });

    const tokens = await KbExternalUserGroupModel.findGroupTokensForUser({
      memberEmail: "user@example.com",
      connectorIds: [connector.id],
    });

    expect(tokens).toEqual(["group:github_eng"]);
  });

  test("findGroupTokensForUser scopes to the given connectors", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connectorA = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "github",
      visibility: "auto-sync-permissions",
    });
    const connectorB = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "jira",
      visibility: "auto-sync-permissions",
    });

    await KbExternalUserGroupModel.upsertMany([
      {
        organizationId: org.id,
        connectorId: connectorA.id,
        connectorType: "github",
        groupId: "eng",
        externalAccountId: "user@example.com",
        memberEmail: "user@example.com",
      },
      {
        organizationId: org.id,
        connectorId: connectorB.id,
        connectorType: "jira",
        groupId: "dev",
        externalAccountId: "user@example.com",
        memberEmail: "user@example.com",
      },
    ]);

    const tokens = await KbExternalUserGroupModel.findGroupTokensForUser({
      memberEmail: "user@example.com",
      connectorIds: [connectorA.id],
    });

    expect(tokens).toEqual(["group:github_eng"]);
  });
});
