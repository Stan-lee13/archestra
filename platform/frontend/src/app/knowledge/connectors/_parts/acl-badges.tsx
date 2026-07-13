// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

"use client";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTeams } from "@/lib/teams/team.query";

const MAX_VISIBLE_ENTRIES = 2;

/**
 * Human-readable rendering of a document's ACL, replicating the Models
 * column on the LLM limits table: up to three full-width outline badges,
 * with everything past that collapsed into a "+N more" badge whose tooltip
 * lists all collapsed entries (scrollable — an auto-sync ACL can carry
 * hundreds). Every entry kind the backend writes is covered: `org:*`,
 * `team:<id>` (resolved to the team name), `user_email:<email>`,
 * `group:<connectorType>_<groupId>`, and the empty ACL (fail-closed — nobody
 * can retrieve the document until a permission sync tags it). Raw tokens stay
 * available on hover for correlation with the User Groups tab.
 */
export function AclBadges({ acl }: { acl: string[] }) {
  const { data: teams } = useTeams();

  if (acl.length === 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="border-amber-600 text-amber-600 text-xs whitespace-nowrap"
          >
            Locked
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          No one can retrieve this document yet — it stays access-restricted
          until a permission sync tags it with its source permissions.
        </TooltipContent>
      </Tooltip>
    );
  }

  const entries = acl.map((entry) => ({
    entry,
    label: formatAclEntry(entry, teams),
  }));
  const visible = entries.slice(0, MAX_VISIBLE_ENTRIES);
  const hidden = entries.slice(MAX_VISIBLE_ENTRIES);

  return (
    <div className="flex flex-wrap gap-1">
      {visible.map(({ entry, label }) => (
        <Badge
          key={entry}
          variant="outline"
          className="max-w-full text-xs"
          title={entry}
        >
          <span className="truncate">{label}</span>
        </Badge>
      ))}
      {hidden.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="cursor-default text-xs">
              +{hidden.length} more
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-80">
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {hidden.map(({ entry, label }) => (
                <div key={entry}>{label}</div>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function formatAclEntry(
  entry: string,
  teams: { id: string; name: string }[] | undefined,
): string {
  if (entry === "org:*") {
    return "Everyone in org";
  }
  if (entry.startsWith("team:")) {
    const teamId = entry.slice("team:".length);
    const team = teams?.find(({ id }) => id === teamId);
    return `Team: ${team?.name ?? teamId}`;
  }
  if (entry.startsWith("user_email:")) {
    return entry.slice("user_email:".length);
  }
  if (entry.startsWith("group:")) {
    return `Group: ${entry.slice("group:".length)}`;
  }
  return entry;
}
