'use strict';
const fs = require('fs');
const path = require('path');

const HOOK_SCHEMA_VERSION = 1;
const SCHEMA_REGEX = /^[1-9][0-9]*\n$/;
const MAX_SCHEMA_BYTES = 32;

function readSchemaVersion(stateDir) {
  const filePath = path.join(stateDir, 'schema_version');
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'not_initialized' };
    throw err;
  }

  if (!stat.isFile()) return { status: 'invalid' };
  if (stat.size > MAX_SCHEMA_BYTES) return { status: 'invalid' };

  const raw = fs.readFileSync(filePath, 'utf8');
  if (!SCHEMA_REGEX.test(raw)) return { status: 'invalid' };

  return { status: 'ok', version: parseInt(raw, 10) };
}

module.exports = { HOOK_SCHEMA_VERSION, readSchemaVersion };
