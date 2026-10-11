import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentName, canQuit, parseLoginItems, parsePs } from '../src/main/busy';

test('ps lines are read, names with spaces too', () => {
  const rows = parsePs('  412 23.5 Google Chrome\n   99  0.4 Slack\nbad line\n');
  assert.deepEqual(rows, [{ pid: 412, cpu: 23.5, name: 'Google Chrome' }, { pid: 99, cpu: 0.4, name: 'Slack' }]);
});

test('macOS parts and non-apps cannot be quit', () => {
  assert.equal(canQuit('Finder', '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder'), false);
  assert.equal(canQuit('node', '/usr/local/bin/node'), false);
  assert.equal(canQuit('Safari', '/System/Volumes/Preboot/x'), false);
  assert.equal(canQuit('Slack', '/Applications/Slack.app/Contents/MacOS/Slack'), true);
});

test('login items and launch agents get readable names', () => {
  assert.deepEqual(parseLoginItems('Dropbox, Spotify\n'), ['Dropbox', 'Spotify']);
  assert.equal(agentName('com.google.keystone.agent.plist'), 'keystone agent');
});
