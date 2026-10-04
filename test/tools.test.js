// The tools, in process, against a fake conv2pdf API.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createClient } from '../src/api.js';
import { resolvePath } from '../src/files.js';
import { TO_PDF_TOOLS, createTools } from '../src/tools.js';
import { QUOTA, RESULT, fakeApi, workspace } from './helpers.js';

/** The tools wired to a fake API, with waits that do not wait. */
async function setup({ respond, files = {}, hasKey = true } = {}) {
  const api = await fakeApi(respond);
  const space = await workspace(files);
  const waits = [];
  const client = createClient({
    apiKey: 'cpdf_live_test',
    baseUrl: api.url,
    userAgent: 'conv2pdf-mcp/test',
    wait: async (ms) => { waits.push(ms); },
  });
  const { tools, callTool } = createTools({ api: client, hasKey });
  return {
    api,
    space,
    waits,
    tools,
    call: (name, args, signal = new AbortController().signal) => callTool(name, args, { signal }),
    close: async () => { await api.close(); await space.cleanup(); },
  };
}

const text = (result) => result.content[0].text;
const conversions = (api) => api.calls.filter((call) => call.method === 'POST');

test('convert_to_pdf uploads the file, writes the PDF next to it and deletes the job', async () => {
  const t = await setup({ files: { 'report.docx': 'a word document' } });
  try {
    const result = await t.call('convert_to_pdf', { input_path: t.space.file('report.docx') });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { output_path: t.space.file('report.pdf'), size_bytes: RESULT.length, quota: QUOTA });
    assert.equal(text(result), JSON.stringify(result.structuredContent));
    assert.deepEqual(await fs.readFile(t.space.file('report.pdf')), RESULT);
    assert.deepEqual(t.api.calls.map((call) => `${call.method} ${call.path}`), [
      'POST /v1/convert/office-to-pdf', 'GET /v1/download/job1', 'DELETE /v1/job/job1',
    ]);
    assert.deepEqual(t.api.calls[0].files, [{ name: 'report.docx', content: 'a word document' }]);
    assert.deepEqual(t.api.calls[0].fields, {});
    for (const call of t.api.calls) assert.equal(call.headers.authorization, 'Bearer cpdf_live_test');
  } finally {
    await t.close();
  }
});

test('convert_to_pdf picks the conv2pdf tool from the extension, whatever its case', async () => {
  const cases = { 'photo.PNG': 'image-to-pdf', 'IMG_1.heic': 'heic-to-pdf', 'book.epub': 'epub-to-pdf', 'notes.pages': 'office-to-pdf', 'sheet.xlsx': 'office-to-pdf' };
  const t = await setup({ files: Object.fromEntries(Object.keys(cases).map((name) => [name, 'x'])) });
  try {
    for (const [name, tool] of Object.entries(cases)) {
      t.api.calls.length = 0;
      const result = await t.call('convert_to_pdf', { input_path: t.space.file(name) });
      assert.equal(result.isError, undefined, name);
      assert.equal(t.api.calls[0].path, `/v1/convert/${tool}`, name);
    }
  } finally {
    await t.close();
  }
});

test('convert_to_pdf refuses an extension it does not know before any upload', async () => {
  const t = await setup({ files: { 'movie.mp4': 'x', 'already.pdf': 'x', noextension: 'x' } });
  try {
    for (const name of ['movie.mp4', 'already.pdf', 'noextension']) {
      const result = await t.call('convert_to_pdf', { input_path: t.space.file(name) });
      assert.equal(result.isError, true, name);
      assert.match(text(result), /convert_to_pdf cannot convert/);
      assert.match(text(result), /\.docx/);
    }
    assert.equal(t.api.calls.length, 0);
    assert.deepEqual((await fs.readdir(t.space.dir)).sort(), ['already.pdf', 'movie.mp4', 'noextension']);
  } finally {
    await t.close();
  }
});

test('an existing file is never overwritten: the default name moves on', async () => {
  const t = await setup({ files: { 'report.docx': 'x', 'report.pdf': 'mine', 'report (2).pdf': 'mine too' } });
  try {
    const result = await t.call('convert_to_pdf', { input_path: t.space.file('report.docx') });
    assert.equal(result.structuredContent.output_path, t.space.file('report (3).pdf'));
    assert.equal(await fs.readFile(t.space.file('report.pdf'), 'utf8'), 'mine');
    assert.equal(await fs.readFile(t.space.file('report (2).pdf'), 'utf8'), 'mine too');
  } finally {
    await t.close();
  }
});

test('output_path is used as given, refused when it exists or when its folder does not', async () => {
  const t = await setup({ files: { 'report.docx': 'x', 'taken.pdf': 'mine' } });
  try {
    const chosen = await t.call('convert_to_pdf', { input_path: t.space.file('report.docx'), output_path: t.space.file('out.pdf') });
    assert.equal(chosen.structuredContent.output_path, t.space.file('out.pdf'));
    assert.deepEqual(await fs.readFile(t.space.file('out.pdf')), RESULT);

    t.api.calls.length = 0;
    const taken = await t.call('convert_to_pdf', { input_path: t.space.file('report.docx'), output_path: t.space.file('taken.pdf') });
    assert.equal(taken.isError, true);
    assert.match(text(taken), /already exists.*Nothing was converted/);
    assert.equal(await fs.readFile(t.space.file('taken.pdf'), 'utf8'), 'mine');

    const nowhere = await t.call('convert_to_pdf', { input_path: t.space.file('report.docx'), output_path: path.join(t.space.dir, 'missing', 'out.pdf') });
    assert.equal(nowhere.isError, true);
    assert.match(text(nowhere), /does not exist/);
    assert.equal(t.api.calls.length, 0);
  } finally {
    await t.close();
  }
});

test('a missing input file, a folder and an empty path are refused before any upload', async () => {
  const t = await setup();
  try {
    assert.match(text(await t.call('compress_pdf', { input_path: t.space.file('nope.pdf') })), /File not found/);
    assert.match(text(await t.call('compress_pdf', { input_path: t.space.dir })), /Not a file/);
    assert.match(text(await t.call('compress_pdf', { input_path: '' })), /"input_path" must be the path of a file/);
    assert.match(text(await t.call('compress_pdf', {})), /"input_path" must be the path of a file/);
    assert.equal(t.api.calls.length, 0);
  } finally {
    await t.close();
  }
});

test('each PDF tool calls its conv2pdf tool with its fields and names its result', async () => {
  const cases = [
    ['convert_heic_to_jpg', { input: 'a.heic' }, 'heic-to-jpg', {}, 'a.jpg'],
    ['convert_pdf_to_word', { password: 'open' }, 'pdf-to-word', { password: 'open' }, 'doc.docx'],
    ['convert_pdf_to_images', { format: 'jpg' }, 'pdf-to-image', { format: 'jpg' }, 'doc.zip'],
    ['convert_pdf_to_images', {}, 'pdf-to-image', {}, 'doc (2).zip'],
    ['extract_pdf_pages', { pages: '1-5,7', password: 'open' }, 'split-pdf', { ranges: '1-5,7', password: 'open' }, 'doc-pages.pdf'],
    ['rotate_pdf', { rotation: 90 }, 'rotate-pdf', { rotation: '90' }, 'doc-rotated.pdf'],
    ['add_page_numbers', { position: 'bottom-right', format: 'simple' }, 'page-numbers-pdf', { position: 'bottom-right', format: 'simple' }, 'doc-numbered.pdf'],
    ['add_watermark', { text: 'DRAFT' }, 'watermark-pdf', { text: 'DRAFT' }, 'doc-watermarked.pdf'],
    ['compress_pdf', { quality: 'low', password: '' }, 'compress-pdf', { quality: 'low' }, 'doc-compressed.pdf'],
    ['protect_pdf', { password: 'secret1', prevent_print: true, prevent_copy: false }, 'protect-pdf', { password: 'secret1', prevent_print: 'on' }, 'doc-protected.pdf'],
    ['protect_pdf', { password: 'secret1', prevent_copy: true }, 'protect-pdf', { password: 'secret1', prevent_copy: 'on' }, 'doc-protected (2).pdf'],
    ['unlock_pdf', {}, 'unlock-pdf', {}, 'doc-unlocked.pdf'],
    ['unlock_pdf', { password: 'old' }, 'unlock-pdf', { password: 'old' }, 'doc-unlocked (2).pdf'],
  ];
  const t = await setup({ files: { 'doc.pdf': 'a pdf', 'a.heic': 'a photo' } });
  try {
    for (const [name, { input = 'doc.pdf', ...args }, tool, fields, output] of cases) {
      t.api.calls.length = 0;
      const result = await t.call(name, { input_path: t.space.file(input), ...args });
      assert.equal(result.isError, undefined, name);
      assert.equal(t.api.calls[0].path, `/v1/convert/${tool}`, name);
      assert.deepEqual(t.api.calls[0].fields, fields, name);
      assert.equal(result.structuredContent.output_path, t.space.file(output), name);
    }
  } finally {
    await t.close();
  }
});

test('merge_pdfs sends the files in the order given and writes next to the first', async () => {
  const t = await setup({ files: { 'b.pdf': 'second', 'a.pdf': 'first' } });
  try {
    const result = await t.call('merge_pdfs', { input_paths: [t.space.file('b.pdf'), t.space.file('a.pdf')] });
    assert.equal(result.structuredContent.output_path, t.space.file('b-merged.pdf'));
    assert.equal(t.api.calls[0].path, '/v1/convert/merge-pdf');
    assert.deepEqual(t.api.calls[0].files, [{ name: 'b.pdf', content: 'second' }, { name: 'a.pdf', content: 'first' }]);

    t.api.calls.length = 0;
    for (const input_paths of [[t.space.file('a.pdf')], 'a.pdf', undefined]) {
      const refused = await t.call('merge_pdfs', { input_paths });
      assert.equal(refused.isError, true);
      assert.match(text(refused), /at least 2 PDFs/);
    }
    assert.equal(t.api.calls.length, 0);
  } finally {
    await t.close();
  }
});

test('a required argument that is missing is refused before any upload', async () => {
  const t = await setup({ files: { 'doc.pdf': 'a pdf' } });
  try {
    const input_path = t.space.file('doc.pdf');
    assert.match(text(await t.call('extract_pdf_pages', { input_path })), /"pages" is required/);
    assert.match(text(await t.call('rotate_pdf', { input_path })), /"rotation" is required/);
    assert.match(text(await t.call('add_watermark', { input_path, text: '' })), /"text" is required/);
    assert.match(text(await t.call('protect_pdf', { input_path })), /"password" is required/);
    assert.equal(t.api.calls.length, 0);
    assert.deepEqual(await fs.readdir(t.space.dir), ['doc.pdf']);
  } finally {
    await t.close();
  }
});

test('a refusal of the API becomes a tool error the model can act on, and leaves no file', async () => {
  const cases = [
    [401, { error: 'invalid_api_key' }, 'compress_pdf', /did not accept the API key.*CONV2PDF_API_KEY.*dashboard\/#developer/],
    [401, {}, 'compress_pdf', /did not accept the API key/],
    [429, { error: 'quota_exceeded' }, 'compress_pdf', /quota of this API key is used up/],
    [422, { error: 'needs_password' }, 'compress_pdf', /pass it as "password"/],
    [422, { error: 'needs_password' }, 'merge_pdfs', /One of the PDFs is protected.*unlock_pdf/],
    [422, { error: 'needs_password' }, 'unlock_pdf', /needs its current password/],
    [422, { error: 'wrong_password' }, 'unlock_pdf', /does not open this PDF/],
    [415, { error: 'unsupported_content', detected_type: 'epub' }, 'compress_pdf', /EPUB e-book.*\.epub.*convert_to_pdf/],
    [415, { error: 'unsupported_content', detected_type: 'constructor' }, 'compress_pdf', /does not match this tool/],
    [413, { error: 'file_too_large', max_bytes: 10485760, plan: 'dev' }, 'compress_pdf', /larger than the 10 MB per file/],
    [400, { error: 'invalid_page_range', range: '9-12', total_pages: 1 }, 'extract_pdf_pages', /"9-12" are not valid for this PDF of 1 page\./],
    [400, { error: 'password_too_short', min: 6 }, 'protect_pdf', /at least 6 characters/],
    [422, { error: 'some_new_code' }, 'compress_pdf', /refused the request \(some_new_code\)/],
    [500, { error: 'conversion_failed' }, 'compress_pdf', /could not process this file.*do not count/],
    [502, {}, 'compress_pdf', /temporarily unavailable/],
  ];
  for (const [status, body, tool, expected] of cases) {
    const t = await setup({ respond: (call) => (call.method === 'POST' ? { status, body } : undefined), files: { 'doc.pdf': 'a pdf', 'other.pdf': 'a pdf' } });
    try {
      const args = tool === 'merge_pdfs'
        ? { input_paths: [t.space.file('doc.pdf'), t.space.file('other.pdf')] }
        : { input_path: t.space.file('doc.pdf'), pages: '9-12', password: 'x' };
      const result = await t.call(tool, args);
      assert.equal(result.isError, true, `${status} ${body.error}`);
      assert.match(text(result), expected, `${status} ${body.error}`);
      assert.deepEqual((await fs.readdir(t.space.dir)).sort(), ['doc.pdf', 'other.pdf'], `${status} ${body.error}`);
    } finally {
      await t.close();
    }
  }
});

test('a rate limit with a short delay is waited out, then the conversion goes through', async () => {
  let refusals = 2;
  const t = await setup({
    respond: (call) => (call.method === 'POST' && refusals-- > 0 ? { status: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': '3' } } : undefined),
    files: { 'doc.pdf': 'a pdf' },
  });
  try {
    const result = await t.call('compress_pdf', { input_path: t.space.file('doc.pdf') });
    assert.equal(result.isError, undefined);
    assert.deepEqual(t.waits, [3000, 3000]);
    assert.equal(conversions(t.api).length, 3);
    // The file is sent again in full at each attempt.
    assert.deepEqual(conversions(t.api).map((call) => call.files[0].content), ['a pdf', 'a pdf', 'a pdf']);
  } finally {
    await t.close();
  }
});

test('a busy server is retried twice, then reported with the delay', async () => {
  const t = await setup({
    respond: (call) => (call.method === 'POST' ? { status: 503, body: { error: 'server_busy', retry_after: 5 } } : undefined),
    files: { 'doc.pdf': 'a pdf' },
  });
  try {
    const result = await t.call('compress_pdf', { input_path: t.space.file('doc.pdf') });
    assert.equal(result.isError, true);
    assert.match(text(result), /queue is full\. Try again in 5 seconds/);
    assert.equal(conversions(t.api).length, 3);
    assert.deepEqual(await fs.readdir(t.space.dir), ['doc.pdf']);
  } finally {
    await t.close();
  }
});

test('a long rate limit is not waited out: the delay goes to the model', async () => {
  const t = await setup({
    respond: (call) => (call.method === 'POST' ? { status: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': '55' } } : undefined),
    files: { 'doc.pdf': 'a pdf' },
  });
  try {
    const result = await t.call('compress_pdf', { input_path: t.space.file('doc.pdf') });
    assert.match(text(result), /rate limit is reached\. Try again in 55 seconds/);
    assert.deepEqual(t.waits, []);
    assert.equal(conversions(t.api).length, 1);
  } finally {
    await t.close();
  }
});

test('a used-up quota is never retried, although it is a 429 too', async () => {
  const t = await setup({
    respond: (call) => (call.method === 'POST' ? { status: 429, body: { error: 'quota_exceeded' }, headers: { 'retry-after': '1' } } : undefined),
    files: { 'doc.pdf': 'a pdf' },
  });
  try {
    await t.call('compress_pdf', { input_path: t.space.file('doc.pdf') });
    assert.equal(conversions(t.api).length, 1);
  } finally {
    await t.close();
  }
});

test('a failed download leaves no file, and a failed deletion does not fail the call', async () => {
  const noDownload = await setup({ respond: (call) => (call.method === 'GET' ? { status: 410, body: { error: 'file_expired' } } : undefined), files: { 'doc.pdf': 'a pdf' } });
  try {
    const result = await noDownload.call('compress_pdf', { input_path: noDownload.space.file('doc.pdf') });
    assert.match(text(result), /no longer available/);
    assert.deepEqual(await fs.readdir(noDownload.space.dir), ['doc.pdf']);
  } finally {
    await noDownload.close();
  }
  const noDelete = await setup({ respond: (call) => (call.method === 'DELETE' ? { status: 500, body: {} } : undefined), files: { 'doc.pdf': 'a pdf' } });
  try {
    const result = await noDelete.call('compress_pdf', { input_path: noDelete.space.file('doc.pdf') });
    assert.equal(result.isError, undefined);
    assert.deepEqual(await fs.readFile(noDelete.space.file('doc-compressed.pdf')), RESULT);
  } finally {
    await noDelete.close();
  }
});

test('get_quota returns the quota of the key', async () => {
  const t = await setup();
  try {
    const result = await t.call('get_quota', {});
    assert.deepEqual(result.structuredContent, QUOTA);
    assert.deepEqual(t.api.calls.map((call) => `${call.method} ${call.path}`), ['GET /v1/quota']);
  } finally {
    await t.close();
  }
});

test('without an API key no file is read and the API is not called', async () => {
  const t = await setup({ files: { 'doc.pdf': 'a pdf' }, hasKey: false });
  try {
    for (const [name, args] of [['compress_pdf', { input_path: t.space.file('doc.pdf') }], ['get_quota', {}]]) {
      const result = await t.call(name, args);
      assert.equal(result.isError, true);
      assert.match(text(result), /CONV2PDF_API_KEY/);
    }
    assert.equal(t.api.calls.length, 0);
  } finally {
    await t.close();
  }
});

test('an unreachable API is reported as such', async () => {
  const space = await workspace({ 'doc.pdf': 'a pdf' });
  try {
    const client = createClient({ apiKey: 'k', baseUrl: 'http://127.0.0.1:9/v1', userAgent: 'test' });
    const { callTool } = createTools({ api: client, hasKey: true });
    const result = await callTool('compress_pdf', { input_path: space.file('doc.pdf') }, { signal: new AbortController().signal });
    assert.equal(result.isError, true);
    assert.match(text(result), /Could not reach conv2pdf/);
    assert.deepEqual(await fs.readdir(space.dir), ['doc.pdf']);
  } finally {
    await space.cleanup();
  }
});

test('a cancelled call throws, so that nothing is sent back, and leaves no file', { timeout: 10_000 }, async () => {
  let release;
  const t = await setup({
    respond: (call) => (call.method === 'POST' ? new Promise((resolve) => { release = () => resolve({ status: 500, body: {} }); }) : undefined),
    files: { 'doc.pdf': 'a pdf' },
  });
  try {
    const controller = new AbortController();
    const pending = t.call('compress_pdf', { input_path: t.space.file('doc.pdf') }, controller.signal);
    while (t.api.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await assert.rejects(pending);
    assert.deepEqual(await fs.readdir(t.space.dir), ['doc.pdf']);
  } finally {
    release?.();
    await t.close();
  }
});

test('paths: ~ is the home folder, a relative path starts at the working directory', () => {
  assert.equal(resolvePath('~/Documents/a.pdf', 'input_path'), path.join(os.homedir(), 'Documents', 'a.pdf'));
  assert.equal(resolvePath('a.pdf', 'input_path'), path.resolve('a.pdf'));
  assert.equal(resolvePath(path.resolve('x', 'a.pdf'), 'input_path'), path.resolve('x', 'a.pdf'));
});

test('the extension table has no duplicate and only lower-case extensions', () => {
  const all = Object.values(TO_PDF_TOOLS).flat();
  assert.equal(new Set(all).size, all.length);
  for (const extension of all) assert.match(extension, /^\.[a-z0-9]+$/);
});
