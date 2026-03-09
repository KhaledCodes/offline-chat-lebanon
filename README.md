# Jisr (جسر) — Offline-First Mesh Chat for Lebanon

Jisr ("bridge" in Arabic) is an offline-first peer-to-peer chat app for Lebanon. It uses Bluetooth Low Energy mesh networking to send encrypted messages without internet, and bridges to [Nostr](https://nostr.com/) when connectivity is available.

## Why

Lebanon has 576 people/km² and 80%+ smartphone penetration, but frequent power outages and damaged telecom infrastructure make centralized messaging unreliable. Jisr requires no servers, accounts, or phone numbers.

## How It Works

```
You ──BLE──> Nearby peer ──BLE──> Their peer ──BLE──> Recipient
                    (mesh relay with TTL + store-and-forward)

You ──Nostr──> Relay ──Nostr──> Recipient
                    (fallback when internet is available)
```

**Transport priority:** BLE Direct > Mesh Relay > Nostr > Queue

## Architecture

| Layer | Technology |
|---|---|
| Framework | React Native 0.77 |
| BLE | Custom native modules (Swift + Kotlin) |
| Encryption | Noise XX handshake (X25519 + ChaCha20-Poly1305) |
| Identity | Ed25519 keypairs, stored encrypted in MMKV |
| Database | SQLite via op-sqlite (JSI) |
| Nostr | NIP-17 gift-wrapped DMs (nostr-tools v2) |
| State | Zustand + MMKV persistence |
| i18n | Arabic (RTL), French, English |

## Project Structure

```
src/
├── ble/            # BLE service, peer discovery, transport
├── mesh/           # Flood routing, bloom filter, store-and-forward
├── crypto/         # Key management, Noise handshake, session encryption
├── nostr/          # Nostr client, relay manager, NIP-17 event builder
├── storage/        # SQLite database, message & contact stores
├── transport/      # Unified send API, outbound queue
├── screens/        # Onboarding, contacts, chat, add contact, settings
├── components/     # Message bubbles, input bar, QR code, connection badge
├── i18n/           # ar.json, fr.json, en.json
└── store/          # Zustand app store

ios/Jisr/BLE/       # Swift CoreBluetooth (Central + Peripheral)
android/.../ble/    # Kotlin Android BLE (Central + Peripheral)
preview/            # HTML prototype (open index.html in a browser)
```

## Setup

```bash
npm install
```

### Run on Android

Requires Android Studio with an emulator or a USB-connected device.

```bash
npx react-native run-android
```

### Run on iOS (Mac only)

```bash
cd ios && pod install && cd ..
npx react-native run-ios
```

### Preview UI (no device needed)

Open `preview/index.html` in any browser to click through the interface.

## Tests

All core logic runs on desktop via Jest — no device or emulator needed.

```bash
npx jest
```

**205 tests** across 7 suites:

- **MeshProtocol** — binary packet encode/decode, field validation, roundtrips
- **BloomFilter** — insertion, lookup, false positive rate, auto-reset
- **PeerTable** — peer tracking, route optimization, stale pruning
- **MessageRelay** — store-and-forward queue, expiry, capacity limits
- **NoiseHandshake** — full XX handshake, key agreement, state machine, abort
- **NoiseSession** — encrypt/decrypt, nonce handling, replay detection, serialization
- **KeyManager** — QR code parsing, base64url encoding, initialization guards

## BLE Protocol

- **GATT Service:** `4A530000-0000-1000-8000-00805F9B34FB`
- **Packet format:** 22 + N bytes (version, type, msgId[8], srcId[4], dstId[4], ttl, hopCount, payload)
- **Routing:** Managed flooding, TTL max 7, random 8-25ms relay jitter
- **Deduplication:** Bloom filter (8KB, 7 hashes, auto-reset at 50K entries)
- **Store-and-forward:** Up to 500 messages cached for 1 hour

## Encryption

- **Identity:** Ed25519 keypair generated on first launch
- **Key exchange:** Noise XX (`Noise_XX_25519_ChaChaPoly_BLAKE2b`) — mutual authentication, forward secrecy
- **Messages:** ChaCha20-Poly1305 IETF with incrementing nonces
- **Contact trust:** QR code exchange (primary), safety numbers for verification
- **QR format:** `jisr://contact?pub=<base64url_ed25519>&name=<name>&v=1`

## License

MIT
