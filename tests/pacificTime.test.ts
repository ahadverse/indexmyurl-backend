import test from 'node:test';
import assert from 'node:assert/strict';
import { getNextPacificMidnight, getPacificDateKey } from '../src/utils/helpers';

const next = (iso: string): string => getNextPacificMidnight(new Date(iso)).toISOString();

test('summer: Pacific is UTC-7 (PDT)', () => {
  assert.equal(next('2026-10-29T12:00:00Z'), '2026-10-30T07:00:00.000Z');
});

test('winter: Pacific is UTC-8 (PST)', () => {
  assert.equal(next('2026-12-10T12:00:00Z'), '2026-12-11T08:00:00.000Z');
});

test('one second before midnight rolls to that midnight', () => {
  assert.equal(next('2026-10-30T06:59:59Z'), '2026-10-30T07:00:00.000Z');
});

test('exactly at midnight rolls to the following midnight', () => {
  assert.equal(next('2026-10-30T07:00:00Z'), '2026-10-31T07:00:00.000Z');
});

test('fall back (Nov 1 2026): the day is 25 hours long', () => {
  assert.equal(next('2026-10-31T20:00:00Z'), '2026-11-01T07:00:00.000Z');
  assert.equal(next('2026-11-01T07:00:00Z'), '2026-11-02T08:00:00.000Z');
  assert.equal(next('2026-11-01T10:00:00Z'), '2026-11-02T08:00:00.000Z');
});

test('spring forward (Mar 8 2026): the day is 23 hours long', () => {
  assert.equal(next('2026-03-08T05:00:00Z'), '2026-03-08T08:00:00.000Z');
  assert.equal(next('2026-03-08T08:00:00Z'), '2026-03-09T07:00:00.000Z');
});

test('date key follows the Pacific calendar, not UTC', () => {
  assert.equal(getPacificDateKey(new Date('2026-10-30T06:00:00Z')), '2026-10-29');
  assert.equal(getPacificDateKey(new Date('2026-10-30T07:00:00Z')), '2026-10-30');
});
