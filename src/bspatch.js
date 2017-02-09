'use strict';

const { decompress, header } = require('bzip2-async');

const MAGIC = "BSDIFF40";
const BUFFER_SIZE = 4096;

function asyncIteratorToStream (iterator) {
  let prevSlice = null;
  let cursor = 0;
  let promiseResult = null;
  const ctrl = {
    type: 'bytes',
    start () {},
    close () {},
    async pull (controller) {
      if (!prevSlice || cursor >= prevSlice.length) {
        prevSlice = null;

        while (true) {
          const { done, value } =
            promiseResult === null ? iterator.next() :
            'error' in promiseResult ? iterator.throw(promiseResult.error) :
            iterator.next(promiseResult.result);

          if (done) {
            controller.close();
            controller.byobRequest && controller.byobRequest.respond(0);
            return;
          }

          if (!value.then) {
            prevSlice = value;
            cursor = 0;
            break;
          }

          try {
            promiseResult = { result: await value };
          } catch (error) {
            promiseResult = { error };
          }
        }
      }

      if (controller.byobRequest) {
        const view = controller.byobRequest.view;
        let written = 0;
        const writeAmount = Math.min(prevSlice.length - cursor, view.length);
        view.set(prevSlice.subarray(cursor, cursor + writeAmount));
        cursor += writeAmount;
        controller.byobRequest.respond(writeAmount);
      } else {
        const result = prevSlice.subarray(cursor);
        prevSlice = null;
        cursor = 0;
        controller.enqueue(result);
      }
    },
  };

  try {
    return new ReadableStream(ctrl);
  } catch (error) {
    delete ctrl.type;
    return new ReadableStream(ctrl);
  }
}

function bitReaderFromStreamReader (streamReader) {
  const BITMASK = new Uint8Array([0, 0x01, 0x03, 0x07, 0x0F, 0x1F, 0x3F, 0x7F, 0xFF]);
  const buffer = new Uint8Array(1);
  let cursor = -1;
  return async function readBits (n) {
  	let result = 0;
  	while (n > 0){
  		if (cursor === -1) {
        const { value : byteContainer, done } = await streamReader.read(buffer);
        if (done || byteContainer.byteLength === 0) { return -1; }
        cursor = 0;
  		}

  		const left = 8 - cursor;
  		const currentByte = buffer[0];

  		if (n >= left) {
  			result <<= left;
  			result |= (BITMASK[left] & currentByte);
  			cursor = -1;
  			n -= left;
  		} else {
  			result <<= n;
  			result |= ((currentByte & (BITMASK[n] << (8 - n - cursor))) >> (8 - n - cursor));
  			cursor += n;
  			n = 0;
  		}
  	}
  	return result;
  };
}

function * bzip2 (streamReader) {
  const bitReader = bitReaderFromStreamReader(streamReader);

  const size = yield header(bitReader);

  while (true) {
    const chunk = yield decompress(bitReader, size);
    if (chunk === -1) { break; }
    const block = new Uint8Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) {
      block[i] = chunk.charCodeAt(i);
    }
    yield block;
  }

  // seek over the CRC
  yield bitReader(8 * 4);
}

function bzip2Stream (streamReader) {
  return asyncIteratorToStream(bzip2(streamReader));
}

function getInt64 (bytes, offset = 0) {
  const result =
    (bytes[offset + 0] & 0xff) << (0 * 8) |
    (bytes[offset + 1] & 0xff) << (1 * 8) |
    (bytes[offset + 2] & 0xff) << (2 * 8) |
    (bytes[offset + 3] & 0xff) << (3 * 8) |
    (bytes[offset + 4] & 0xff) << (4 * 8) |
    (bytes[offset + 5] & 0xff) << (5 * 8) |
    (bytes[offset + 6] & 0xff) << (6 * 8) |
    (bytes[offset + 7] & 0x7f) << (7 * 8);
  const signed = bytes[offset + 7] & 0x80 != 0;
  return signed ? -result : result;
}

function add (left, right, offset, end) {
  for (let i = offset; i < end; i++) {
    left[i] += right[i];
  }

  return left;
}

function getAsciiString (bytes, offset, end) {
  let string = '';

  for (let i = offset; i < end; i++) {
    string += String.fromCharCode(bytes[i]);
  }

  return string;
}

function emulateBYOB (streamReader) {
  if (streamReader.read.length === 1) { return streamReader; }
  let buffer = null;
  let offset = 0;

  async function read (destination) {
    if (!buffer || buffer.length === offset) {
      let done;
      ({ value : buffer, done } = await streamReader.read());
      if (done) { return { done, value: destination.subarray(0, 0) }; }
      offset = 0;
    }

    const copyAmount = Math.min(destination.length, buffer.length - offset);
    destination.set(buffer.subarray(offset, offset + copyAmount));
    offset += copyAmount;
    const value = destination.subarray(0, copyAmount);
    return { done: false, value };
  }

  return { read };
}

function getBYOBReader (stream) {
  try {
    return stream.getReader({ mode: 'byob' });
  } catch (error) {
    return emulateBYOB(stream.getReader());
  }
}

async function read (streamReader, buffer, offset, end) {
  if (offset >= end) { return; }
  const destination = buffer.subarray(offset, end);
  const { value: newView, done } = await streamReader.read(destination);
  if (done) { throw new Error('Unexpected EOF'); }
  return read(streamReader, buffer, offset + newView.byteLength, end);
}

async function readControlHeader (streamReader) {
  const data = new Uint8Array(24);
  await read(streamReader, data, 0, data.length);
  const addSize = getInt64(data, 0 * 8);
  const copySize = getInt64(data, 1 * 8);
  const seekSize = getInt64(data, 2 * 8);
  return { addSize, copySize, seekSize };
}

async function readHeader (streamReader) {
  const data = new Uint8Array(32);
  await read(streamReader, data, 0, data.length);
  const magic = getAsciiString(data, 0, 8);
  const controlSize = getInt64(data, 1 * 8);
  const diffSize = getInt64(data, 2 * 8);
  const newSize = getInt64(data, 3 * 8);
  return { magic, controlSize, diffSize, newSize };
}

function typedArrayStreamReader (typedArray) {
  return getBYOBReader(asyncIteratorToStream([typedArray][Symbol.iterator]()));
}

function * bspatch (oldReader, patchReader) {
  oldReader = emulateBYOB(oldReader);
  patchReader = emulateBYOB(patchReader);

  const { magic, controlSize, diffSize, newSize } = yield readHeader(patchReader);

  if (magic != MAGIC || controlSize < 0 || diffSize < 0 || newSize < 0) {
    throw new Error('Corrupt patch');
  }

  const control = new Uint8Array(controlSize);
  const controlReader = getBYOBReader(bzip2Stream(typedArrayStreamReader(control)));
  yield read(patchReader, control, 0, controlSize);

  const diff = new Uint8Array(diffSize);
  const diffReader = getBYOBReader(bzip2Stream(typedArrayStreamReader(diff)));
  yield read(patchReader, diff, 0, diffSize);

  const extraReader = getBYOBReader(bzip2Stream(patchReader));

  const temp1 = new Uint8Array(BUFFER_SIZE);
  const temp2 = new Uint8Array(BUFFER_SIZE);
  let newPos = 0;
  let oldPos = 0;

  while (newPos < newSize) {
    const { addSize, copySize, seekSize } = yield readControlHeader(controlReader);

    if (newPos + addSize > newSize || addSize < 0) {
      throw new Error('Corrupt patch');
    }

    for (let i = 0; i < addSize; i += BUFFER_SIZE) {
      const readAmount = Math.min(BUFFER_SIZE, addSize - i);
      yield Promise.all([read(oldReader, temp1, 0, readAmount), read(diffReader, temp2, 0, readAmount)]);
      add(temp1, temp2, 0, readAmount);
      newPos += readAmount;
      oldPos += readAmount;
      yield temp1.slice(0, readAmount);
    }

    if (newPos + copySize > newSize || copySize < 0) {
      throw new Error('Corrupt patch');
    }

    for (let i = 0; i < copySize; i += BUFFER_SIZE) {
      const readAmount = Math.min(BUFFER_SIZE, copySize - i);
      yield read(extraReader, temp1, 0, readAmount);
      newPos += readAmount;
      yield temp1.slice(0, readAmount);
    }

    if (seekSize < 0) {
      throw new Error('Corrupt patch');
    }

    for (let i = 0; i < seekSize; i += BUFFER_SIZE) {
      const readAmount = Math.min(BUFFER_SIZE, seekSize - i);
      yield read(oldReader, temp1, 0, readAmount);
      oldPos += readAmount;
    }
  }
}

function bspatchStream (oldReader, patchReader) {
  return asyncIteratorToStream(bspatch(oldReader, patchReader));
}

module.exports = bspatchStream;
