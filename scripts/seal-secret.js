#!/usr/bin/env node
'use strict';

/**
 * Кладёт значение в GitHub Actions secret (libsodium sealed box).
 * Требует пакеты tweetnacl и blakejs только на машине оператора:
 *
 *   npm i tweetnacl blakejs
 *   GITHUB_TOKEN=... node scripts/seal-secret.js owner/repo SECRET_NAME path/to/file
 *
 * Сам секрет не появляется в логах и не попадает в репозиторий.
 */

const fs = require('fs');
const nacl = require('tweetnacl');
const { blake2b } = require('blakejs');

const main = async () => {
  const [repo, name, file] = process.argv.slice(2);
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !name || !file || !token) {
    console.error('usage: GITHUB_TOKEN=... node scripts/seal-secret.js owner/repo SECRET file');
    process.exit(2);
  }

  const metaRes = await fetch('https://api.github.com/repos/' + repo + '/actions/secrets/public-key', {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!metaRes.ok) {
    console.error('public-key: HTTP ' + metaRes.status);
    process.exit(1);
  }
  const meta = await metaRes.json();
  const recipient = Buffer.from(meta.key, 'base64');

  const ephemeral = nacl.box.keyPair();
  const nonce = blake2b(
    Buffer.concat([Buffer.from(ephemeral.publicKey), recipient]),
    null,
    24
  );
  const shared = nacl.box.before(recipient, ephemeral.secretKey);
  const message = fs.readFileSync(file);
  const cipher = nacl.box.after(message, nonce, shared);
  const sealed = Buffer.concat([Buffer.from(ephemeral.publicKey), Buffer.from(cipher)]);

  const put = await fetch(
    'https://api.github.com/repos/' + repo + '/actions/secrets/' + name,
    {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        encrypted_value: sealed.toString('base64'),
        key_id: meta.key_id,
      }),
    }
  );
  if (!put.ok && put.status !== 201 && put.status !== 204) {
    console.error('secret update: HTTP ' + put.status + ' ' + (await put.text()));
    process.exit(1);
  }
  console.log('secret ' + name + ' обновлён в ' + repo);
};

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});