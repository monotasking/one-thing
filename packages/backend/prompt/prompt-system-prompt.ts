import defaultSystemRaw from "./content/default-system.md?raw";
import knownProjectsRaw from "./content/known-projects-instructions.md?raw";

// Normalize all trailing newlines so the .md file can have any number of
// trailing blank lines without changing the runtime value.
const normalize = (s: string) => s.replace(/\n+$/, "");

// Tool guidelines / workspace rules used to be two more constants here. They
// now live on the tools that they are about (`ToolInfo.prompt` — edit, write,
// variable) and follow the tool surface; see prompts/builder.ts.
export const ONETHING_DEFAULT_SYSTEM_PROMPT = normalize(defaultSystemRaw);
export const ONETHING_KNOWN_PROJECTS_INSTRUCTIONS = normalize(knownProjectsRaw);
