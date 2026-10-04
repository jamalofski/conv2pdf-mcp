// The tools of the server: what the model reads, and what a call does.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ApiError } from './api.js';
import { InputError, discardOutput, inputFile, reserveOutput } from './files.js';
import { NO_KEY, apiErrorText } from './messages.js';

export const INSTRUCTIONS =
  'conv2pdf converts and edits files that are on this computer: Office documents, images and e-books to PDF, ' +
  'PDF to Word or to images, and merging, extracting pages, rotating, numbering, watermarking, compressing, ' +
  'protecting or unlocking PDFs. Give a tool the path of the file: the result is written next to it, or at ' +
  'output_path, and its path is returned. The files are uploaded to conv2pdf, hosted in France, which deletes ' +
  'them once the result is downloaded. Each conversion uses one unit of the quota of the API key, including one ' +
  'that conv2pdf refuses after reading the file (an unreadable or scanned PDF, too many pages); a refused setting, ' +
  'such as a page range that does not exist, and a failure on the side of conv2pdf are not counted. get_quota ' +
  'tells what is left.';

// convert_to_pdf picks the conv2pdf tool from the extension of the file. These lists are
// the `accepted_exts` of GET /v1/tools: `npm run check-tools` compares them.
export const TO_PDF_TOOLS = {
  'office-to-pdf': [
    '.doc', '.docx', '.docm', '.odt', '.rtf', '.txt', '.xls', '.xlsx', '.xlsm', '.ods', '.csv', '.ppt', '.pptx',
    '.pptm', '.odp', '.odg', '.sxw', '.sxc', '.sxi', '.sxd', '.pages', '.fodt', '.fods', '.fodp', '.fodg',
  ],
  'image-to-pdf': ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.tiff', '.tif'],
  'heic-to-pdf': ['.heic', '.heif'],
  'epub-to-pdf': ['.epub'],
};

function toPdfTool(input) {
  const extension = path.extname(input).toLowerCase();
  for (const [tool, extensions] of Object.entries(TO_PDF_TOOLS)) {
    if (extensions.includes(extension)) return tool;
  }
  throw new InputError(
    `convert_to_pdf cannot convert ${extension ? `a ${extension} file` : 'a file without extension'}. ` +
    `It accepts: ${Object.values(TO_PDF_TOOLS).flat().join(' ')}`,
  );
}

const SENT = 'The file is uploaded to conv2pdf and the call counts as one conversion.';

const INPUT_PATH = {
  type: 'string',
  description: 'Path of the file on this computer: absolute, or relative to the working directory of the server.',
};
const OUTPUT_PATH = {
  type: 'string',
  description:
    'Where to write the result. Optional: by default next to the input file, under a name that is not taken. An existing file is never overwritten.',
};
const PDF_PASSWORD = {
  type: 'string',
  description: 'Password of the PDF, only if it asks for one to open. The result has no password.',
};

// One entry per tool that converts files:
//   api: the conv2pdf tool, or a function of the input file that names it
//   properties, required: the arguments besides input_path and output_path
//   fields: the form fields sent with the file, from the arguments
//   suffix, extension: the default name of the result
//   messages: the API error codes this tool words itself
const FILE_TOOLS = [
  {
    name: 'convert_to_pdf',
    title: 'Convert to PDF',
    description:
      'Converts a document, an image or an e-book to PDF: Word, Excel, PowerPoint, OpenDocument, Apple Pages, RTF, TXT, CSV, PNG, JPG, WebP, GIF, TIFF, HEIC and EPUB. The converter is chosen from the extension of the file.',
    api: toPdfTool,
    extension: '.pdf',
  },
  {
    name: 'convert_heic_to_jpg',
    title: 'Convert HEIC to JPG',
    description: 'Converts an iPhone HEIC or HEIF photo to a JPG image.',
    api: 'heic-to-jpg',
    extension: '.jpg',
  },
  {
    name: 'convert_pdf_to_word',
    title: 'Convert PDF to Word',
    description:
      'Converts a PDF that contains real text to an editable Word document (DOCX). A scanned PDF, made of images without text, is refused.',
    api: 'pdf-to-word',
    properties: { password: PDF_PASSWORD },
    fields: (args) => ({ password: args.password }),
    extension: '.docx',
  },
  {
    name: 'convert_pdf_to_images',
    title: 'Convert PDF to Images',
    description:
      'Renders each page of a PDF as an image at 150 DPI. The result is one ZIP archive with an image per page. Up to 100 pages.',
    api: 'pdf-to-image',
    properties: {
      format: { type: 'string', enum: ['png', 'jpg'], description: 'Format of the images. Default: png.' },
      password: PDF_PASSWORD,
    },
    fields: (args) => ({ format: args.format, password: args.password }),
    extension: '.zip',
  },
  {
    name: 'merge_pdfs',
    title: 'Merge PDFs',
    description:
      'Combines several PDFs into one, in the order given. 2 files on the Dev plan, up to 20 on paid plans. The result is written next to the first file.',
    api: 'merge-pdf',
    multiple: true,
    suffix: '-merged',
    messages: {
      needs_password: 'One of the PDFs is protected with a password: remove it first with unlock_pdf.',
      password_protected: 'One of the PDFs is protected with a password: remove it first with unlock_pdf.',
    },
  },
  {
    name: 'extract_pdf_pages',
    title: 'Extract Pages From PDF',
    description: 'Keeps some pages of a PDF in a new PDF. The pages keep the order they have in the document.',
    api: 'split-pdf',
    properties: {
      pages: {
        type: 'string',
        description: 'Pages to keep: numbers and ranges separated by commas, such as 1-5,7,10-12.',
      },
      password: PDF_PASSWORD,
    },
    required: ['pages'],
    fields: (args) => ({ ranges: args.pages, password: args.password }),
    suffix: '-pages',
  },
  {
    name: 'rotate_pdf',
    title: 'Rotate PDF',
    description: 'Rotates every page of a PDF clockwise.',
    api: 'rotate-pdf',
    properties: {
      rotation: { type: 'integer', enum: [90, 180, 270], description: 'Rotation in degrees, clockwise.' },
      password: PDF_PASSWORD,
    },
    required: ['rotation'],
    fields: (args) => ({ rotation: args.rotation, password: args.password }),
    suffix: '-rotated',
  },
  {
    name: 'add_page_numbers',
    title: 'Add Page Numbers to PDF',
    description: 'Prints the page number at the bottom of every page of a PDF.',
    api: 'page-numbers-pdf',
    properties: {
      position: {
        type: 'string',
        enum: ['bottom-center', 'bottom-left', 'bottom-right'],
        description: 'Where the number goes. Default: bottom-center.',
      },
      format: {
        type: 'string',
        enum: ['full', 'simple'],
        description: 'full prints the page and the total, as "3 / 12"; simple prints "3". Default: full.',
      },
      password: PDF_PASSWORD,
    },
    fields: (args) => ({ position: args.position, format: args.format, password: args.password }),
    suffix: '-numbered',
  },
  {
    name: 'add_watermark',
    title: 'Add Watermark to PDF',
    description: 'Stamps a text diagonally across every page of a PDF.',
    api: 'watermark-pdf',
    properties: {
      text: {
        type: 'string',
        description: 'Text of the watermark, such as CONFIDENTIAL: 50 characters at most, Latin letters, digits and punctuation.',
      },
      password: PDF_PASSWORD,
    },
    required: ['text'],
    fields: (args) => ({ text: args.text, password: args.password }),
    suffix: '-watermarked',
  },
  {
    name: 'compress_pdf',
    title: 'Compress PDF',
    description: 'Reduces the size of a PDF by lowering the resolution of its images.',
    api: 'compress-pdf',
    properties: {
      quality: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'Resolution kept for the images: low is 72 DPI and gives the smallest file, medium 150 DPI, high 300 DPI. Default: medium.',
      },
      password: PDF_PASSWORD,
    },
    fields: (args) => ({ quality: args.quality, password: args.password }),
    suffix: '-compressed',
  },
  {
    name: 'protect_pdf',
    title: 'Protect PDF With Password',
    description: 'Encrypts a PDF (AES-256) so that it asks for a password to open, and optionally forbids printing or copying.',
    api: 'protect-pdf',
    properties: {
      password: { type: 'string', description: 'Password needed to open the PDF, 6 to 64 characters.' },
      prevent_print: { type: 'boolean', description: 'Forbid printing. Default: false.' },
      prevent_copy: { type: 'boolean', description: 'Forbid copying text. Default: false.' },
    },
    required: ['password'],
    // The API reads any value of these two fields as a yes: they are sent only when true.
    fields: (args) => ({
      password: args.password,
      prevent_print: args.prevent_print === true ? 'on' : undefined,
      prevent_copy: args.prevent_copy === true ? 'on' : undefined,
    }),
    suffix: '-protected',
  },
  {
    name: 'unlock_pdf',
    title: 'Unlock PDF',
    description:
      'Removes the password and the restrictions of a PDF whose password is known. It does not find a forgotten password.',
    api: 'unlock-pdf',
    properties: {
      password: {
        type: 'string',
        description:
          'Current password of the PDF. Leave it out for a PDF that opens without a password but restricts printing or copying.',
      },
    },
    fields: (args) => ({ password: args.password }),
    suffix: '-unlocked',
    messages: { needs_password: 'This PDF needs its current password to be unlocked: pass it as "password".' },
  },
];

function definition(spec) {
  const input = spec.multiple
    ? {
        input_paths: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 20,
          description: 'Paths of the PDFs on this computer, in the order they must appear in the result.',
        },
      }
    : { input_path: INPUT_PATH };
  return {
    name: spec.name,
    title: spec.title,
    description: `${spec.description} ${SENT}`,
    inputSchema: {
      type: 'object',
      properties: { ...input, ...spec.properties, output_path: OUTPUT_PATH },
      required: [spec.multiple ? 'input_paths' : 'input_path', ...(spec.required ?? [])],
      additionalProperties: false,
    },
    // Each call writes a new file and never replaces one; the input leaves this computer.
    annotations: { title: spec.title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  };
}

const GET_QUOTA = {
  name: 'get_quota',
  title: 'Get Quota',
  description:
    'Returns the plan of the conv2pdf API key and how many conversions it has used and may still use. Reading the quota is free.',
  inputSchema: { type: 'object', additionalProperties: false },
  annotations: { title: 'Get Quota', readOnlyHint: true, openWorldHint: false },
};

const toolResult = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
// A tool error is a result, not a protocol error: it is the form the model reads, so the
// only one it can act on.
const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });

async function inputFiles(spec, args) {
  if (!spec.multiple) return [await inputFile(args.input_path, 'input_path')];
  if (!Array.isArray(args.input_paths) || args.input_paths.length < 2) {
    throw new InputError('"input_paths" must list at least 2 PDFs.');
  }
  const files = [];
  for (const given of args.input_paths) files.push(await inputFile(given, 'input_paths'));
  return files;
}

async function convertFile(spec, args, api, signal) {
  for (const name of spec.required ?? []) {
    if (args[name] === undefined || args[name] === '') throw new InputError(`"${name}" is required.`);
  }
  const inputs = await inputFiles(spec, args);
  const tool = typeof spec.api === 'function' ? spec.api(inputs[0]) : spec.api;
  const fields = Object.fromEntries(
    Object.entries(spec.fields ? spec.fields(args) : {}).filter(([, value]) => value !== undefined && value !== ''),
  );
  const output = await reserveOutput({
    requested: args.output_path,
    input: inputs[0],
    suffix: spec.suffix ?? '',
    extension: spec.extension ?? '.pdf',
  });
  let job;
  try {
    const converted = await api.convert(tool, inputs, fields, { signal });
    job = converted.job;
    await pipeline(Readable.fromWeb(converted.download.body), output.handle.createWriteStream(), { signal });
  } catch (error) {
    await discardOutput(output);
    throw error;
  }
  await api.deleteJob(job.job_id);
  const { size } = await fs.stat(output.file);
  return { output_path: output.file, size_bytes: size, quota: job.quota };
}

/**
 *   api: the conv2pdf client (api.js)
 *   hasKey: whether an API key is configured
 * Returns the tool definitions and the function that runs a call.
 */
export function createTools({ api, hasKey }) {
  const specs = new Map(FILE_TOOLS.map((spec) => [spec.name, spec]));
  const tools = [...FILE_TOOLS.map(definition), GET_QUOTA];

  async function callTool(name, args, { signal }) {
    if (!hasKey) return toolError(NO_KEY);
    const spec = specs.get(name);
    try {
      if (!spec) return toolResult(await api.quota({ signal }));
      return toolResult(await convertFile(spec, args, api, signal));
    } catch (error) {
      if (error instanceof InputError) return toolError(error.message);
      if (error instanceof ApiError) return toolError(apiErrorText(error, spec?.messages));
      if (error.name === 'TimeoutError') return toolError('conv2pdf did not answer in time. Try again in a moment.');
      if (error instanceof TypeError && error.message === 'fetch failed') {
        return toolError('Could not reach conv2pdf. Check the network connection and try again.');
      }
      if (typeof error.code === 'string' && error.syscall) {
        return toolError(`Could not write the result: ${error.message}`);
      }
      // A call cancelled by the client ends here too: the protocol layer sends nothing back.
      throw error;
    }
  }

  return { tools, callTool };
}
