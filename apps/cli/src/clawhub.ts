/**
 * ClaWHub client — re-exported from @agentoctopus/skills.
 *
 * The implementation lives in packages/skills/src/clawhub-install.ts.
 */

export {
  DEFAULT_REGISTRY,
  SKILLS_INDEX_URL,
  fetchSkillMeta,
  searchSkills,
  installSkill,
  fetchAwesomeSlugs,
  downloadSkillsIndex,
  installFromIndex,
} from "@agentoctopus/skills";

export type {
  SkillIndexEntry,
  ClaWHubSkillMeta,
  ClaWHubSearchResult,
} from "@agentoctopus/skills";
