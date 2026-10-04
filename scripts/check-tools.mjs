// Compares the extensions convert_to_pdf routes on with what the live API accepts
// (GET /v1/tools, public). Run it before a release: `npm run check-tools`.
import { TO_PDF_TOOLS } from '../src/tools.js';

// The other tools of the API, each behind a tool of this server.
const PDF_TOOLS = [
  'heic-to-jpg', 'merge-pdf', 'split-pdf', 'compress-pdf', 'protect-pdf', 'pdf-to-word', 'pdf-to-image',
  'rotate-pdf', 'unlock-pdf', 'watermark-pdf', 'page-numbers-pdf',
];

function compare(live) {
  const problems = [];
  for (const [tool, extensions] of Object.entries(TO_PDF_TOOLS)) {
    const accepted = live.get(tool);
    if (!accepted) {
      problems.push(`${tool}: not a tool of the API any more`);
      continue;
    }
    const missing = accepted.filter((extension) => !extensions.includes(extension));
    const extra = extensions.filter((extension) => !accepted.includes(extension));
    if (missing.length) problems.push(`${tool}: the API also accepts ${missing.join(' ')}`);
    if (extra.length) problems.push(`${tool}: the API does not accept ${extra.join(' ')}`);
  }
  for (const tool of PDF_TOOLS) {
    if (!live.has(tool)) problems.push(`${tool}: not a tool of the API any more`);
  }
  const known = new Set([...Object.keys(TO_PDF_TOOLS), ...PDF_TOOLS]);
  for (const tool of live.keys()) {
    if (!known.has(tool)) problems.push(`${tool}: a tool of the API this server does not offer`);
  }
  return problems;
}

// No process.exit(): right after a fetch it crashes Node on Windows (libuv assertion).
const response = await fetch('https://api.conv2pdf.com/v1/tools');
if (!response.ok) {
  console.error(`GET /v1/tools answered HTTP ${response.status}`);
  process.exitCode = 2;
} else {
  const live = new Map((await response.json()).tools.map((tool) => [tool.id, tool.accepted_exts]));
  const problems = compare(live);
  for (const problem of problems) console.error(problem);
  console.log(problems.length ? 'Drift between the API and this server.' : `In line with the API: ${live.size} tools.`);
  process.exitCode = problems.length ? 1 : 0;
}
