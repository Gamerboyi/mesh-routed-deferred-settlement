// ===== TAB SWITCHING =====
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('content-' + btn.dataset.tab).classList.add('active');
    });
});

// ===== LOGGING =====
function log(msg) {
    const el = document.getElementById('log');
    const time = new Date().toLocaleTimeString();
    el.textContent = `[${time}] ${msg}\n` + el.textContent;
}

// ===== DATA REFRESH =====
async function refresh() {
    try {
        // Mesh state
        const m = await fetch('/api/mesh/state').then(r => r.json());
        const devicesDiv = document.getElementById('devices');
        devicesDiv.innerHTML = m.devices.map(d => `
            <div class="device-card ${d.hasInternet ? 'bridge' : 'offline'} ${d.packetCount > 0 ? 'has-packets' : ''}">
                <div class="device-name">${formatDeviceName(d.deviceId)}</div>
                <span class="device-status ${d.hasInternet ? 'online' : 'offline'}">
                    ${d.hasInternet ? '🌐 4G' : '🚫 Offline'}
                </span>
                <div class="packet-count">${d.packetCount} packet${d.packetCount !== 1 ? 's' : ''} held</div>
                <div class="device-packets">
                    ${d.packetIds.map(id => `<span class="packet-chip">${id}</span>`).join('')}
                </div>
            </div>
        `).join('');

        document.getElementById('cacheInfo').textContent =
            `Idempotency cache size: ${m.idempotencyCacheSize}`;

        // Accounts
        const accs = await fetch('/api/accounts').then(r => r.json());
        document.querySelector('#accounts-table tbody').innerHTML = accs.map(a => `
            <tr>
                <td>${a.vpa}</td>
                <td>${a.holderName}</td>
                <td class="balance-cell">₹${parseFloat(a.balance).toFixed(2)}</td>
            </tr>
        `).join('');

        // Transactions
        const txs = await fetch('/api/transactions').then(r => r.json());
        document.querySelector('#tx-table tbody').innerHTML = txs.length === 0
            ? '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:24px">No transactions yet — run the demo above!</td></tr>'
            : txs.map(t => `
                <tr>
                    <td>${t.id}</td>
                    <td>${t.senderVpa}</td>
                    <td>${t.receiverVpa}</td>
                    <td class="balance-cell">₹${parseFloat(t.amount).toFixed(2)}</td>
                    <td><span class="status-badge status-${t.status}">${formatStatus(t.status)}</span></td>
                    <td>${t.bridgeNodeId}</td>
                    <td>${t.hopCount}</td>
                    <td style="color:var(--text-muted);font-size:12px">${new Date(t.settledAt).toLocaleTimeString()}</td>
                </tr>
            `).join('');
    } catch (e) {
        console.error('Refresh failed:', e);
    }
}

// ===== DEMO ACTIONS =====
async function sendPacket() {
    const btn = document.getElementById('btn-send');
    btn.disabled = true;
    btn.textContent = '⏳ Encrypting...';

    try {
        const body = {
            senderVpa: document.getElementById('senderVpa').value,
            receiverVpa: document.getElementById('receiverVpa').value,
            amount: parseFloat(document.getElementById('amount').value),
            pin: document.getElementById('pin').value,
            ttl: 5,
            startDevice: 'phone-alice'
        };
        const r = await fetch('/api/demo/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(r => r.json());

        log(`📤 Packet ${r.packetId.substring(0, 8)} encrypted & injected at ${r.injectedAt} (TTL ${r.ttl})`);
        log(`   🔐 ciphertext: ${r.ciphertextPreview}`);
        await refresh();

        // Auto-switch to demo tab if on learn tab
        if (document.getElementById('content-learn').classList.contains('active')) {
            document.querySelector('[data-tab="demo"]').click();
        }
    } catch (e) {
        log(`❌ Error: ${e.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = '📤 Inject into Mesh';
    }
}

async function gossip() {
    const btn = document.getElementById('btn-gossip');
    btn.disabled = true;
    btn.textContent = '⏳ Broadcasting...';

    try {
        const r = await fetch('/api/mesh/gossip', { method: 'POST' }).then(r => r.json());
        log(`🔄 Gossip complete: ${r.transfers} transfer(s)`);

        const counts = Object.entries(r.deviceCounts)
            .map(([k, v]) => `${formatDeviceName(k)}:${v}`)
            .join('  ');
        log(`   📊 ${counts}`);
        await refresh();
    } catch (e) {
        log(`❌ Error: ${e.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = '🔄 Run Gossip Round';
    }
}

async function flushBridges() {
    const btn = document.getElementById('btn-flush');
    btn.disabled = true;
    btn.textContent = '⏳ Uploading...';

    try {
        const r = await fetch('/api/mesh/flush', { method: 'POST' }).then(r => r.json());
        log(`📡 ${r.uploadsAttempted} bridge upload(s) attempted:`);
        r.results.forEach(res => {
            const icon = res.outcome === 'SETTLED' ? '✅' :
                         res.outcome === 'DUPLICATE_DROPPED' ? '⚠️' : '❌';
            log(`   ${icon} ${res.bridgeNode} → packet ${res.packetId} → ${formatStatus(res.outcome)}` +
                (res.reason ? ` (${res.reason})` : ''));
        });
        await refresh();
    } catch (e) {
        log(`❌ Error: ${e.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = '📡 Bridges Upload';
    }
}

async function resetMesh() {
    const btn = document.getElementById('btn-reset');
    btn.disabled = true;

    try {
        await fetch('/api/mesh/reset', { method: 'POST' });
        log('🗑 Mesh network and idempotency cache cleared');
        await refresh();
    } catch (e) {
        log(`❌ Error: ${e.message}`);
    } finally {
        btn.disabled = false;
    }
}

// ===== HELPERS =====
function formatDeviceName(id) {
    return id.replace('phone-', '').replace(/^\w/, c => c.toUpperCase());
}

function formatStatus(status) {
    const map = {
        'SETTLED': 'Settled',
        'DUPLICATE_DROPPED': 'Duplicate',
        'REJECTED': 'Rejected',
        'INVALID': 'Invalid'
    };
    return map[status] || status;
}

// ===== INIT =====
refresh();
setInterval(refresh, 3000);
