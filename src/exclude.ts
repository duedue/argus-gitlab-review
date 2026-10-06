import { minimatch } from "minimatch";

export function isExcluded(path: string, globs: string[]): boolean {
  return globs.some((g) => minimatch(path, g, { dot: true }));
}
