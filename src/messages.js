// What a refusal of the conv2pdf API means, said to the model: it reads this text, so it
// must tell what to change or what to report to the user.

const PRICING_URL = 'https://conv2pdf.com/en/api/pricing/';
export const KEYS_URL = 'https://conv2pdf.com/en/dashboard/#developer';

export const NO_KEY =
  'No conv2pdf API key. Set the CONV2PDF_API_KEY environment variable in the configuration of this MCP server. ' +
  `Keys are created in the Developer tab of the conv2pdf dashboard: ${KEYS_URL}`;

// A table entry for a value from the API, never a property every object inherits.
const own = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);

const megabytes = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;

const OFFICE_ELSEWHERE = 'This file is an office document: use convert_to_pdf, with the extension of its real format.';
const IMAGE_ELSEWHERE = 'This file is an image: use convert_to_pdf, with the extension of its real format.';
const WEB_PAGE = 'This file contains a web page, not the expected document.';

// What conv2pdf found in a file that does not match the tool (`detected_type`).
const CONTENT_HINTS = {
  pdf: 'This file is already a PDF.',
  epub: 'This file is an EPUB e-book: give it the .epub extension and use convert_to_pdf.',
  pages: OFFICE_ELSEWHERE,
  docx: OFFICE_ELSEWHERE,
  xlsx: OFFICE_ELSEWHERE,
  pptx: OFFICE_ELSEWHERE,
  odt: OFFICE_ELSEWHERE,
  ods: OFFICE_ELSEWHERE,
  odp: OFFICE_ELSEWHERE,
  odg: OFFICE_ELSEWHERE,
  png: IMAGE_ELSEWHERE,
  jpeg: IMAGE_ELSEWHERE,
  gif: IMAGE_ELSEWHERE,
  webp: IMAGE_ELSEWHERE,
  tiff: IMAGE_ELSEWHERE,
  heic: 'This file is a HEIC photo: give it the .heic extension and use convert_to_pdf or convert_heic_to_jpg.',
  html: WEB_PAGE,
  xml: WEB_PAGE,
  svg: WEB_PAGE,
  text: 'This file contains plain text, not the expected document.',
  image_corrupt: 'This image is damaged or incomplete.',
  zip_corrupt: 'This file is damaged or incomplete.',
  msg: 'This file is an Outlook message (.msg), not a document.',
  iwork_numbers:
    'This file is a Numbers spreadsheet, which conv2pdf does not convert. In Numbers, choose File > Export To > PDF.',
  iwork_keynote:
    'This file is a Keynote presentation, which conv2pdf does not convert. In Keynote, choose File > Export To > PDF.',
  iwork: 'conv2pdf converts Apple Pages documents only, named with their .pages extension.',
};

// One entry per code of the `error` field, as text or built from the response body.
const MESSAGES = {
  invalid_api_key: `conv2pdf did not accept the API key. Check CONV2PDF_API_KEY in the configuration of this MCP server. Keys are created in the Developer tab of the conv2pdf dashboard: ${KEYS_URL}`,
  account_not_provisioned: `This API key has no conv2pdf API plan. Plans: ${PRICING_URL}`,
  quota_exceeded: `The conv2pdf quota of this API key is used up. Paid plans renew it every month, the Dev trial does not. Plans: ${PRICING_URL}`,
  credits_expired: `The conv2pdf trial credits have expired. Plans: ${PRICING_URL}`,
  rate_limited: (body, retryAfter) => `The conv2pdf rate limit is reached. Try again in ${retryAfter} seconds.`,
  server_busy: (body, retryAfter) => `The conv2pdf conversion queue is full. Try again in ${retryAfter} seconds.`,
  file_too_large: (body) =>
    `The file is larger than ${Number.isInteger(body.max_bytes) ? `the ${megabytes(body.max_bytes)} per file` : 'what'} this conv2pdf plan allows. Plans: ${PRICING_URL}`,
  payload_too_large: 'The request is larger than conv2pdf accepts.',
  plan_limit_files: `This conv2pdf plan does not merge that many files at once: 2 on the Dev plan, up to 20 on paid plans. Plans: ${PRICING_URL}`,
  not_enough_files: 'Merging needs at least 2 PDFs.',
  too_many_files: 'conv2pdf merges up to 20 PDFs at a time.',
  unsupported_content: (body) =>
    own(CONTENT_HINTS, body.detected_type) ||
    'The content of the file does not match this tool: conv2pdf checks what the file contains, not only its name.',
  unsupported_format: 'conv2pdf cannot read this image format. Use a PNG, JPG, WebP, GIF or TIFF image.',
  empty_file: 'The file is empty.',
  source_unreadable: 'conv2pdf could not read this file: it may be damaged or incomplete.',
  field_required: (body) => `The "${typeof body.field === 'string' ? body.field : 'required'}" field is empty.`,
  invalid_page_range: (body) =>
    `The pages${typeof body.range === 'string' ? ` "${body.range}"` : ''} are not valid${Number.isInteger(body.total_pages) ? ` for this PDF of ${body.total_pages} page${body.total_pages === 1 ? '' : 's'}` : ''}. Use page numbers and ranges separated by commas, such as 1-5,7,10-12.`,
  invalid_rotation: 'The rotation must be 90, 180 or 270 degrees.',
  invalid_format: 'This format is not accepted by the tool.',
  invalid_quality: 'The quality must be low, medium or high.',
  password_protected: 'The file is protected with a password. For a PDF, remove it first with unlock_pdf. A DRM-protected e-book or a locked iWork document cannot be converted.',
  needs_password: 'The PDF asks for a password to open: pass it as "password".',
  wrong_password: 'The password does not open this PDF.',
  password_too_short: (body) => `The password must have at least ${Number.isInteger(body.min) ? body.min : 6} characters.`,
  password_too_long: (body) => `The password must have at most ${Number.isInteger(body.max) ? body.max : 64} characters.`,
  pdf_already_protected: 'The PDF is already protected with a password. Remove it first with unlock_pdf.',
  pdf_not_protected: 'The PDF has no password or restriction to remove.',
  pdf_scanned_needs_ocr: 'This PDF is a scan without text, so it cannot be converted to Word.',
  pdf_too_many_pages: 'The PDF has too many pages for this tool.',
  too_many_pages: (body) =>
    Number.isInteger(body.max_pages)
      ? `The document has more than the ${body.max_pages.toLocaleString('en-US')} pages this tool accepts.`
      : 'The document has too many pages for this tool.',
  unsupported_characters: 'The watermark text has no character conv2pdf can print: use Latin letters, digits and punctuation.',
  epub_blank_output:
    'This e-book cannot be converted: its pages are full-screen images (comics, picture books, manga), and their layout does not survive the conversion to PDF.',
  epub_too_long: 'The e-book is longer than the 1,500 pages conv2pdf converts at once.',
  output_too_large: 'The result is too large to be delivered.',
  // The API refunds the quota on these two, and on a refused setting (page range, rotation,
  // password length). A refusal that follows the reading of the file (unreadable or scanned
  // PDF, too many pages) stays counted.
  conversion_failed: 'conv2pdf could not process this file. The failure is on its side and is not counted against the quota.',
  conversion_timeout: 'The conversion took too long and was stopped. It is not counted against the quota.',
  file_expired: 'The converted file is no longer available on conv2pdf.',
  job_deleted: 'The conversion was deleted on conv2pdf before it could be downloaded.',
};
MESSAGES.missing_bearer_token = MESSAGES.invalid_api_key;

/**
 * The text of a tool error for an ApiError. A tool words a code itself through `overrides`,
 * when the general text would point the model at the wrong fix.
 */
export function apiErrorText(error, overrides = {}) {
  const { status, body, code, retryAfter } = error;
  const message = own(overrides, code) ?? own(MESSAGES, code);
  if (message) return typeof message === 'function' ? message(body, retryAfter) : message;
  if (status === 401) return MESSAGES.invalid_api_key;
  if (status >= 500) {
    return 'conv2pdf is temporarily unavailable: try again in a few minutes.';
  }
  return code ? `conv2pdf refused the request (${code}).` : `conv2pdf returned HTTP ${status}.`;
}
