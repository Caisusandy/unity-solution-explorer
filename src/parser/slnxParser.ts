import * as path from 'path';
import type { SlnProject } from './slnParser';

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Parse .slnx XML solution files and extract referenced C# project paths.
 */
export function parseSlnx(slnxPath: string, content: string): SlnProject[] {
  const projects: SlnProject[] = [];
  const slnxDir = path.dirname(slnxPath);
  const projectRegex = /<Project\b[^>]*\bPath\s*=\s*(["'])(.*?)\1[^>]*\/?>/g;
  let m: RegExpExecArray | null;

  while ((m = projectRegex.exec(content)) !== null) {
    const relativePath = decodeXmlAttribute(m[2].trim()).replace(/[\\/]/g, path.sep);
    if (!relativePath.toLowerCase().endsWith('.csproj')) continue;

    const absolutePath = path.resolve(slnxDir, relativePath);
    const name = path.basename(relativePath, path.extname(relativePath));
    projects.push({ name, relativePath, absolutePath, id: relativePath });
  }

  return projects;
}
