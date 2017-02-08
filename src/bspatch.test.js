'use strict';

const fs = require('fs');
const child_process = require('child_process');

global.ReadableStream = require('../streams/readable-stream').ReadableStream;

const bspatchStream = require('./bspatch');

const CHARS = 'abcdef';
const EXTRA_CHARS = 'ghj';

const readStreamAsText = async stream => {
  const b = new Uint8Array(1024);
  const buffers = [];
  const reader = stream.getReader({ mode: 'byob' });

  while (true) {
    const { value: buffer, done } = await reader.read(b);
    if (done) { break; }
    buffers.push(buffer.slice());
  }

  const size = buffers.reduce((size, buffer) => size + buffer.byteLength, 0);
  const result = new Uint8Array(size);

  let cursor = 0;
  buffers.forEach(buffer => {
    result.subarray(cursor, cursor + buffer.length).set(buffer);
    cursor += buffer.length;
  });

  return new Buffer(result).toString('utf8');
};

const bufferStream = buffer => {
  const contents = new Uint8Array(buffer);
  let cursor = 0;
  return new ReadableStream({
    type: 'bytes',
    start () {},
    close () {},
    pull (controller) {
      if (controller.byobRequest) {
        controller.byobRequest.view.set(contents.subarray(cursor, cursor + controller.byobRequest.view.byteLength));
        cursor += controller.byobRequest.view.byteLength;
        controller.byobRequest.respond(controller.byobRequest.view.byteLength);
      } else {
        controller.enqueue(contents.subarray(cursor));
      }
    },
  });
};

const modify = data => {
  const iterations = Math.floor(Math.random() * 2 + 1);
  for (let i = 0; i < iterations; i++) {
    const type = ['add', 'remove', 'change'][Math.floor(Math.random() * 3)];
    const start = Math.floor(Math.random() * (data.length - 1) + 2);
    const end = start + Math.floor(Math.random() * (data.length - start));
    const size = Math.floor(Math.random() * 100 + 1);

    switch (type) {
      case 'add': {
        const chunk = randomString(size, EXTRA_CHARS);
        data = data.substr(0, start) + chunk + data.substr(start);
        break;
      }
      case 'remove': {
        data = data.substr(0, start) + data.substr(end);
        break;
      }
      case 'change': {
        const chunk = randomString(size, EXTRA_CHARS);
        data = data.substr(0, start) + chunk + data.substr(end);
        break;
      }
    }
  }

  return data;
};

const randomString = (size, chars = CHARS) => {
  let data = '';

  for (let i = 0; i < size; i++) {
    data += chars[Math.floor(Math.random() * chars.length)];
  }

  return data;
};

describe('bspatch', () => {
  test('it should match built in bspatch', async () => {
    for (let i = 0; i < 30; i++) {
      const fixture = randomString(Math.floor(Math.random() * 1000 + 500));
      const expected = modify(fixture);
      fs.writeFileSync('fixture.txt', fixture, 'utf8');
      fs.writeFileSync('expected.txt', expected, 'utf8');
      child_process.execSync('bsdiff fixture.txt expected.txt patch.patch');
      const fixtureStreamReader = bufferStream(fs.readFileSync('fixture.txt')).getReader({ mode: 'byob' });
      const patchStreamReader = bufferStream(fs.readFileSync('patch.patch')).getReader({ mode: 'byob' });
      const result = await readStreamAsText(bspatchStream(fixtureStreamReader, patchStreamReader));
      expect(result).toBe(expected);
    }
  });
});
