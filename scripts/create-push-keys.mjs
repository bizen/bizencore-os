import { writeFile } from 'node:fs/promises';
import webpush from 'web-push';
const file = '.env.web-push.local';
const keys = webpush.generateVAPIDKeys();
await writeFile(file, `WEB_PUSH_PUBLIC_KEY=${keys.publicKey}\nWEB_PUSH_PRIVATE_KEY=${keys.privateKey}\n`, { flag: 'wx', mode: 0o600 });
console.log(`Created ${file}. Keep the private key server-side and reuse this pair across releases.`);
