import test from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../src/greet.mjs';
test('greet', () => assert.equal(greet('x'), 'hi x'));
