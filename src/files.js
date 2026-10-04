// The paths the model gives: where the input is read and where the result is written.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** A problem with a path or an argument: its message becomes the tool error. */
export class InputError extends Error {}

/** An absolute path for what the model wrote: `~` is the home folder, the rest is relative to the working directory. */
export function resolvePath(given, argument) {
  if (typeof given !== 'string' || given.trim() === '') {
    throw new InputError(`"${argument}" must be the path of a file.`);
  }
  const inHome = given === '~' || given.startsWith('~/') || given.startsWith('~\\');
  return path.resolve(inHome ? path.join(os.homedir(), given.slice(1)) : given);
}

/** The absolute path of an existing input file. */
export async function inputFile(given, argument) {
  const file = resolvePath(given, argument);
  let stats;
  try {
    stats = await fs.stat(file);
  } catch {
    throw new InputError(`File not found: ${file}`);
  }
  if (!stats.isFile()) throw new InputError(`Not a file: ${file}`);
  return file;
}

/**
 * Creates the output file, empty, before the conversion starts, and returns its path and
 * its handle. Created exclusively: an existing file is never overwritten, and a refusal
 * comes before any conversion is counted.
 *   requested: the `output_path` of the model, if any
 *   input: the input file the default name derives from
 *   suffix, extension: `report.pdf` + `-compressed` + `.pdf` gives `report-compressed.pdf`
 */
export async function reserveOutput({ requested, input, suffix, extension }) {
  if (requested !== undefined) {
    const target = resolvePath(requested, 'output_path');
    try {
      return { file: target, handle: await fs.open(target, 'wx') };
    } catch (error) {
      if (error.code === 'EEXIST') throw new InputError(`${target} already exists: give another "output_path". Nothing was converted.`);
      if (error.code === 'ENOENT') throw new InputError(`The folder ${path.dirname(target)} does not exist. Nothing was converted.`);
      throw new InputError(`Cannot write ${target}: ${error.message}. Nothing was converted.`);
    }
  }
  const { dir, name } = path.parse(input);
  for (let n = 1; ; n++) {
    const target = path.join(dir, `${name}${suffix}${n === 1 ? '' : ` (${n})`}${extension}`);
    try {
      return { file: target, handle: await fs.open(target, 'wx') };
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw new InputError(`Cannot write ${target}: ${error.message}. Give an "output_path" in a folder that can be written. Nothing was converted.`);
    }
  }
}

/** Removes the reserved file when no result came to fill it. */
export async function discardOutput({ file, handle }) {
  await handle.close().catch(() => {});
  await fs.unlink(file).catch(() => {});
}
