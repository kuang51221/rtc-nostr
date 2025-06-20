import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  verifyEvent
} from "https://esm.sh/@nostr/tools@2.15.0/pure?target=es2020";

import { SimplePool } from "https://esm.sh/@nostr/tools@2.15.0/pool?target=es2020";

let sk, pk;
const pool = new SimplePool();
const relays = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://relay.snort.social"
];

let sub;

function log(msg) {
  const el = document.getElementById("log");
  el.textContent += msg + "\n";
  el.scrollTop = el.scrollHeight;
}

window.onload = () => {
  document.getElementById("btnGen").onclick = generateKeys;
  document.getElementById("btnPub").onclick = publishNote;
  document.getElementById("btnSub").onclick = subscribeNotes;
};

function generateKeys() {
  sk = generateSecretKey();
  pk = getPublicKey(sk);
  log(`🔐 SecretKey (hex): ${sk}`);
  log(`🔑 PublicKey: ${pk}`);
}

function subscribeNotes() {
      if (!pk) return alert("先產生金鑰");
      log("🎧 訂閱最近 5 分鐘 kind‑1 note");
      pool.subscribe(
        relays,
        {
            kinds: [1],
            authors: [pk],
            since: Math.floor(Date.now()/1000) - 300
        },
        {
            onevent(event) {
            log(`got event: ${event.content} by ${event.pubkey.slice(0,8)}`)
            }
        }
  )}
    

async function publishNote() {
        if (!sk) return alert("先產生金鑰");
        const content = document.getElementById("txt").value;

        const ev = finalizeEvent({
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content
        }, sk);

        log(`📝 發送: "${ev.content}" id=${ev.id.slice(0, 8)}...`);

        // 發送到多個 relay
        const signedEvent = finalizeEvent(ev, sk)
        const results = await Promise.any(pool.publish(relays, signedEvent))
        log(results)
    }

