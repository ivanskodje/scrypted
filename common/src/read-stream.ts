import { Readable } from 'stream';
import { once } from 'events';

export async function read16BELengthLoop(readable: Readable, options: {
  headerLength: number;
  offset?: number;
  // optionally skip a header, and pause loop parsing until calee resumes.
  skipHeader?: (header: Buffer, resumeRead: () => void) => boolean;
  callback: (header: Buffer, data: Buffer) => void;
}) {
  let error: Error;
  const { skipHeader, callback } = options;
  const offset = options.offset || 0;
  const headerLength = options.headerLength || 2;

  readable.on('error', e => error = e);

  let header: Buffer;
  let length: number;
  let skipCount = 0;
  let readCount = 0;

  const resumeRead = () => {
    readCount++;
    read();
  }

  const read = () => {
    while (true) {
      if (skipCount !== readCount)
        return;
      if (!header) {
        header = readable.read(headerLength);
        if (!header)
          return;
        if (skipHeader?.(header, resumeRead)) {
          skipCount++;
          header = undefined;
          continue;
        }
        length = header.readUInt16BE(offset);
      }
      else {
        const data = readable.read(length);
        if (!data)
          return;
        callback(header, data);
        header = undefined;
      }
    }
  };

  read();
  readable.on('readable', read);

  await once(readable, 'end');
  throw new Error('stream ended');
}

export class StreamEndError extends Error {
  constructor() {
    super('stream ended');
  }
}

export async function readLength(readable: Readable, length: number): Promise<Buffer> {
  if (readable.readableEnded || readable.destroyed)
    throw new StreamEndError();

  if (!length) {
    return Buffer.alloc(0);
  }

  {
    const ret = readable.read(length);
    if (ret) {
      return ret;
    }
  }

  return new Promise((resolve, reject) => {
    const r = () => {
      const ret = readable.read(length);
      if (ret) {
        cleanup();
        resolve(ret);
        return;
      }

      if (readable.readableEnded || readable.destroyed)
        reject(new Error("stream ended during read"));
    };

    const e = () => {
      cleanup();
      reject(new StreamEndError())
    };

    const cleanup = () => {
      readable.removeListener('readable', r);
      readable.removeListener('end', e);
    }

    readable.on('readable', r);
    readable.on('end', e);
  });
}

const CHARCODE_NEWLINE = '\n'.charCodeAt(0);

export async function readUntil(readable: Readable, charCode: number) {
  const queued: Buffer[] = [];
  while (true) {
    const available: Buffer = readable.read();
    if (!available) {
      await once(readable, 'readable');
      continue;
    }
    const index = available.findIndex(b => b === charCode);
    if (index === -1) {
      queued.push(available);
      continue;
    }

    const before = available.subarray(0, index);
    queued.push(before);

    const after = available.subarray(index + 1);
    readable.unshift(after);
    return Buffer.concat(queued).toString();
  }
}

export async function readLine(readable: Readable) {
  return readUntil(readable, CHARCODE_NEWLINE);
}

export async function readString(readable: Readable | Promise<Readable>) {
  let data = '';
  readable = await readable;
  readable.on('data', buffer => {
    data += buffer.toString();
  });
  readable.resume();
  await once(readable, 'end')
  return data;
}
