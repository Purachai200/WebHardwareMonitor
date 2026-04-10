const dgram = require('dgram');
const ip = require('ip');

/**
 * A minimal mDNS advertiser in pure Node.js (no libraries)
 * It responds to "A" queries for {name}.local with the machine's local IP.
 */
class mDNSAdvertiser {
    constructor(hostname) {
        this.hostname = hostname.endsWith('.local') ? hostname : `${hostname}.local`;
        this.port = 5353;
        this.multicastAddr = '224.0.0.251';
        this.socket = null;
    }

    start() {
        this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        this.socket.on('message', (msg, rinfo) => {
            try {
                this.handleQuery(msg, rinfo);
            } catch (err) {
                // Ignore malformed packets
            }
        });

        this.socket.on('error', (err) => {
            console.error('mDNS Socket Error:', err);
        });

        this.socket.bind(this.port, () => {
            try {
                this.socket.addMembership(this.multicastAddr);
                console.log(`📡 mDNS: Advertising ${this.hostname}`);
            } catch (e) {
                console.error('❌ mDNS membership error:', e.message);
            }
        });
    }

    stop() {
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
    }

    handleQuery(msg, rinfo) {
        // Simple DNS header parsing
        const qdCount = msg.readUInt16BE(4);
        if (qdCount === 0) return;

        // Skip header (12 bytes)
        let offset = 12;

        for (let i = 0; i < qdCount; i++) {
            const { name, nextOffset } = this.parseName(msg, offset);
            offset = nextOffset;

            // Type (2 bytes) and Class (2 bytes)
            const type = msg.readUInt16BE(offset);
            const qClass = msg.readUInt16BE(offset + 2);
            offset += 4;

            // If query is for hostname and type A (1) or ANY (255)
            if (name.toLowerCase() === this.hostname.toLowerCase() && (type === 1 || type === 255)) {
                this.sendResponse(rinfo);
            }
        }
    }

    parseName(msg, offset) {
        let name = '';
        let nextOffset = -1;
        let curr = offset;

        while (true) {
            const len = msg[curr];
            if (len === 0) {
                if (nextOffset === -1) nextOffset = curr + 1;
                break;
            }

            if ((len & 0xC0) === 0xC0) { // Pointer compression
                if (nextOffset === -1) nextOffset = curr + 2;
                curr = ((len & 0x3F) << 8) | msg[curr + 1];
                continue;
            }

            if (name.length > 0) name += '.';
            name += msg.toString('utf8', curr + 1, curr + 1 + len);
            curr += len + 1;
        }

        return { name, nextOffset };
    }

    sendResponse(rinfo) {
        const myIp = ip.address();
        const ipParts = myIp.split('.').map(Number);
        if (ipParts.length !== 4) return;

        // Construct Response Packet
        const nameParts = this.hostname.split('.');
        const nameBuf = Buffer.concat([
            ...nameParts.map(p => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])),
            Buffer.from([0])
        ]);

        const header = Buffer.alloc(12);
        header.writeUInt16BE(0, 0);      // ID
        header.writeUInt16BE(0x8400, 2); // Flags: Response, Authoritative
        header.writeUInt16BE(0, 4);      // QD Count
        header.writeUInt16BE(1, 6);      // AN Count
        header.writeUInt16BE(0, 8);      // NS Count
        header.writeUInt16BE(0, 10);     // AR Count

        const answer = Buffer.alloc(10);
        answer.writeUInt16BE(1, 0);      // Type A
        answer.writeUInt16BE(0x8001, 2); // Class IN + Cache Flush
        answer.writeUInt32BE(120, 4);    // TTL 120s
        answer.writeUInt16BE(4, 8);      // Data Length 4 (IP)

        const packet = Buffer.concat([header, nameBuf, answer, Buffer.from(ipParts)]);

        // Send to multicast group
        this.socket.send(packet, 0, packet.length, this.port, this.multicastAddr);
    }
}

module.exports = mDNSAdvertiser;
