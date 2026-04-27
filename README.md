# Mesh-Routed Deferred Settlement System

A Spring Boot backend that demonstrates **offline instant payments (UPI/FedNow/PIX) routed through a Bluetooth-style mesh network**. 

Imagine you are in a basement or a remote area with zero internet connectivity. You send a friend $50 / ₹500. Your phone encrypts the payment, broadcasts it to nearby phones via Bluetooth, and the packet hops device-to-device until *some* phone walks outside, connects to 4G/5G, and silently uploads it to this backend. The backend decrypts, deduplicates, and settles the transaction.

This repository contains the **server-side settlement engine**, plus a software simulator of the mesh network so you can demo the entire store-and-forward flow on a single laptop without requiring real Bluetooth hardware.

---

## Table of Contents

1. [What this demo proves](#what-this-demo-proves)
2. [Global Use Cases](#global-use-cases)
3. [How to run it](#how-to-run-it)
4. [The demo flow (step by step)](#the-demo-flow-step-by-step)
5. [Architecture](#architecture)
6. [The three hard problems and how they're solved](#the-three-hard-problems-and-how-theyre-solved)
7. [File-by-file walkthrough](#file-by-file-walkthrough)
8. [API reference](#api-reference)
9. [Tests](#tests)
10. [Production Roadmap](#production-roadmap)
11. [Honest limitations of the concept](#honest-limitations-of-the-concept)

---

## What this demo proves

The system shows three critical distributed systems challenges solved end-to-end:

1. **Untrusted Routing:** A payment can travel from sender to backend through untrusted intermediaries without any of them being able to read or tamper with it. (Hybrid RSA-OAEP + AES-GCM encryption).
2. **Exactly-Once Processing:** Even if the exact same payment packet reaches the backend simultaneously through multiple bridge nodes (duplicate storms), it settles exactly once. (Idempotency via atomic compare-and-swap on the ciphertext hash).
3. **Replay & Tamper Protection:** A tampered or replayed packet is mathematically rejected before it ever touches the financial ledger.

---

## Global Use Cases

While initially inspired by India's **UPI (Unified Payments Interface)**, this mesh-routed architecture is universally applicable to any real-time payment rail globally:
- **India:** UPI (Offline P2P transfers in rural areas or crowded stadiums).
- **USA:** FedNow / Zelle (Disaster recovery zones where cell towers are down).
- **Brazil:** PIX (Underground transit systems).
- **Europe:** SEPA Instant (Cross-border mesh routing).

---

## How to run it

### Prerequisites

- **JDK 17 or newer** installed and on PATH.
- No database, no Redis, no Maven installation required (the wrapper handles it). 

### Run on Windows

Open a terminal in the project folder and run:
```cmd
mvnw.cmd spring-boot:run
```

### Run on Mac/Linux

```bash
./mvnw spring-boot:run
```

### Open the dashboard

Once you see `Started UpiMeshApplication`, open:
**http://localhost:8081** (or 8080 depending on your config).

### Run the tests

```cmd
mvnw.cmd test
```
*Note: The `IdempotencyConcurrencyTest` fires three threads delivering the same packet simultaneously to assert exactly-once settlement.*

---

## The demo flow (step by step)

### Step 1 — Compose a payment
Choose sender, receiver, amount, and PIN. Click **"📤 Inject into Mesh"**.
- The server simulates the sender's offline phone.
- It builds a payload with a unique nonce and timestamp, encrypts it with the server's RSA public key, wraps it in a packet with a TTL of 5, and gives it to a simulated offline device.

### Step 2 — Run gossip rounds
Click **"🔄 Run Gossip Round"**. 
- Simulates the Epidemic/Gossip protocol. Every device holding a packet broadcasts it to every other device nearby. TTL decrements per hop.

### Step 3 — Bridge node walks outside
Click **"📡 Bridges Upload to Backend"**.
- The "bridge" device simulates finding internet connectivity. It POSTs all packets it holds to the backend ingestion pipeline.

### Step 4 — Demonstrate idempotency (the killer feature)
- Reset the mesh, inject a packet, and gossip until 3 different bridge nodes hold the same packet.
- When they all upload simultaneously, the backend's atomic lock ensures exactly one node triggers the ledger update. The others are safely dropped.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         SENDER PHONE (offline)                          │
│  PaymentInstruction { sender, receiver, amount, pinHash, nonce, time }  │
│              │                                                          │
│              ▼ encrypt with server's RSA public key                     │
│   MeshPacket { packetId, ttl, createdAt, ciphertext }                   │
└──────────────────────────────────────┬──────────────────────────────────┘
                                       │ Bluetooth gossip (Store-and-Forward)
                                       ▼
        ┌─────────┐  hop   ┌─────────┐  hop   ┌─────────┐
        │stranger1│ ─────▶ │stranger2│ ─────▶ │ bridge  │ ◀── walks outside
        └─────────┘        └─────────┘        └────┬────┘     gets 4G
                                                   │
                                                   ▼ HTTPS POST
┌─────────────────────────────────────────────────────────────────────────┐
│                     SPRING BOOT BACKEND (Settlement Engine)             │
│                                                                         │
│  /api/bridge/ingest                                                     │
│       │                                                                 │
│  [1] hash ciphertext (SHA-256)                                          │
│       │                                                                 │
│  [2] IdempotencyService.claim(hash)  ◀── Atomic putIfAbsent (CAS).      │
│       │                                  Duplicates dropped instantly.  │
│  [3] HybridCryptoService.decrypt()                                      │
│       │       (RSA-OAEP unwraps AES key, AES-GCM decrypts payload       │
│       │        AND verifies the auth tag — tampering = exception)       │
│  [4] Freshness check: signedAt within last 24h (Replay protection)      │
│       │                                                                 │
│  [5] SettlementService.settle()                                         │
│       @Transactional: debit sender, credit receiver, write ledger       │
│       @Version on Account = optimistic locking (defense in depth)       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## The three hard problems and how they're solved

### Problem 1: Untrusted intermediates
A stranger's phone is carrying the transaction. How do you stop them from reading the amount or modifying the receiver?

**Solution: Hybrid Authenticated Encryption (RSA-OAEP + AES-GCM).**
The payload is encrypted using a fresh AES-256 key, and that AES key is encrypted using the server's RSA Public Key. Because we use GCM (Galois/Counter Mode), it provides *Authenticated Encryption*. If an intermediary flips a single bit in the ciphertext, the decryption throws an exception.

### Problem 2: The Thundering Herd / Duplicate-storm
Three bridge nodes hold the same packet. They all get internet simultaneously and POST to the ingestion API. Naively processing them would drain the sender's account three times.

**Solution: Atomic Compare-and-Swap (CAS) Idempotency.**
The server hashes the ciphertext (SHA-256) and uses it as an idempotency key. It calls `ConcurrentHashMap.putIfAbsent(hash)`. This is atomic—even if 100 threads hit it at the exact same nanosecond, exactly one thread proceeds. The others are short-circuited in microseconds. (In production, this map is replaced by Redis `SETNX`).

### Problem 3: Replay attacks
An attacker captures a valid encrypted packet and replays it 3 months later.

**Solution: Cryptographic Nonces & Freshness Windows.**
The encrypted payload contains a `signedAt` timestamp and a `nonce` (UUID). The server rejects packets older than 24 hours. Even if a user sends two identical $10 payments legally, the unique nonces generate completely different ciphertexts, preventing false-positive duplicate drops.

---

## File-by-file walkthrough

```text
├── model/                           ── Domain layer
│   ├── Account.java                 JPA entity. @Version = optimistic lock
│   ├── Transaction.java             Ledger. Unique index on packetHash
│   ├── MeshPacket.java              Wire format. Outer fields readable, ciphertext opaque
│   └── PaymentInstruction.java      Decrypted payload
├── crypto/                          ── Cryptography layer
│   ├── ServerKeyHolder.java         Generates RSA-2048 keypair
│   └── HybridCryptoService.java     RSA-OAEP + AES-256-GCM + ciphertext hashing
├── service/                         ── Business logic
│   ├── DemoService.java             Simulates sender phone cryptography
│   ├── MeshSimulatorService.java    Gossip protocol DTN simulator
│   ├── IdempotencyService.java      Atomic caching (JVM-local Redis SETNX)
│   ├── SettlementService.java       @Transactional ACID settlement
│   └── BridgeIngestionService.java  THE pipeline: hash → claim → decrypt → freshness → settle
└── controller/                      ── HTTP layer
    └── ApiController.java           REST endpoints
```

---

## API reference

| Method | Path | What it does |
|---|---|---|
| GET | `/api/server-key` | Server's RSA public key (base64) for offline caching |
| POST | `/api/demo/send` | Simulate sender phone — encrypt + inject packet |
| POST | `/api/mesh/gossip` | Run one round of epidemic routing across the mesh |
| POST | `/api/mesh/flush` | Bridges with internet upload to backend (parallel) |
| POST | `/api/bridge/ingest` | **The production endpoint.** Real bridges POST here |

---

## What's NOT real (Production Roadmap)

This is an architectural demonstration. To make it production-grade, the following infrastructure changes would be made:

| What's in the demo | Production Equivalent |
|---|---|
| H2 in-memory DB | PostgreSQL / MySQL with replicas |
| `ConcurrentHashMap` for idempotency | Redis cluster using `SET key NX EX 86400` |
| RSA keypair in RAM | Private key locked in **AWS KMS** or a physical **HSM** |
| `MeshSimulatorService` | Real BLE GATT characteristics / Wi-Fi Direct on Android/iOS |
| No rate limiting | API Gateway (e.g., Kong/Envoy) with strict bridge-node rate limits |

---

## Honest limitations of the concept

For absolute transparency, "mesh-routed deferred settlement" carries inherent limitations that cannot be solved with software alone:

1. **No cryptographic proof of funds:** When the sender hands the receiver a phone showing "$50 sent," it is technically an IOU. If the sender's account is empty when the packet reaches the backend, the settlement is `REJECTED`. *This is why real offline systems (like UPI Lite) require a pre-funded hardware secure element to guarantee funds offline.*
2. **Double-spending:** A malicious sender could send an offline packet to Alice, walk across the room, and send an offline packet to Bob using the same funds. Whichever reaches the backend first settles; the other bounces. 

The cryptography and idempotency architecture in this repo is designed to protect the **integrity of the routing network** and the **server's settlement logic**, assuming the business accepts the delayed-settlement risk profile.
