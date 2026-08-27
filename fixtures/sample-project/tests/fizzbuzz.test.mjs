import test from 'node:test';
import assert from 'node:assert/strict';

import { fizzbuzz } from '../src/fizzbuzz.mjs';

test('numbers not divisible by 3 or 5 return the number as a string', () => {
  assert.equal(fizzbuzz(1), '1');
  assert.equal(fizzbuzz(2), '2');
  assert.equal(fizzbuzz(7), '7');
});

test('multiples of 3 (not 5) return "Fizz"', () => {
  assert.equal(fizzbuzz(3), 'Fizz');
  assert.equal(fizzbuzz(9), 'Fizz');
});

test('multiples of 5 (not 3) return "Buzz"', () => {
  assert.equal(fizzbuzz(5), 'Buzz');
  assert.equal(fizzbuzz(20), 'Buzz');
});

test('multiples of 15 return "FizzBuzz"', () => {
  assert.equal(fizzbuzz(15), 'FizzBuzz');
  assert.equal(fizzbuzz(45), 'FizzBuzz');
});
