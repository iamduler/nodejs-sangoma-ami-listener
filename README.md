# Node.js Sangoma AMI Listener

Production-ready Node.js TypeScript service for listening to Asterisk AMI (Asterisk Manager Interface) events from Sangoma PBX/FreePBX and forwarding them as normalized webhooks to your CRM system.

## Features

- ✅ **AMI Connection**: Connects to Asterisk AMI over TCP with auto-reconnect
- ✅ **Event Listening**: Monitors key call events (DialBegin, BridgeEnter, Hangup)
- ✅ **Event Merging**: Automatically merges Hangup and BridgeEnter events with the same `linkedid` for outbound calls
  - Combines caller (extension/internal) and callee (external/trunk) information into a single event
  - Identifies caller/callee based on context (`from-internal` vs `from-trunk`)
  - Includes hotline information in merged events
  - 2-second timeout for waiting for the second event before sending
- ✅ **Raw Event Forwarding**: Forwards original AMI event format to webhook endpoint (no normalization for DialBegin)
- ✅ **Event Filtering**: Automatically filters out events with:
  - Channels starting with "Local/" or "Macro/"
  - Destination channels (for DialBegin) starting with "Local/" or "Macro/"
  - Extensions 's' (start) or 'h' (hangup)
- ✅ **Data Sanitization**: Automatically removes `incomingData` field and adds `timestamp` to events before sending
- ✅ **Webhook Delivery**: POST webhooks with exponential backoff retry mechanism
- ✅ **Idempotency**: Prevents duplicate webhook deliveries using uniqueid
- ✅ **Local Timezone**: All timestamps use Asia/Ho_Chi_Minh timezone (UTC+7)
- ✅ **Reliability**: Graceful shutdown, structured JSON logging, health check endpoints
- ✅ **Production Ready**: PM2 configuration for process management

## Requirements

- Node.js >= 18.0.0
- npm or yarn
- PM2 (for production deployment)
- Access to Asterisk AMI (Sangoma PBX/FreePBX)
- CRM webhook endpoint URL

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd nodejs-sangoma-ami-listener
```

2. Install dependencies:
```bash
npm install
```

3. Copy environment variables template:
```bash
cp .env.example .env
```

4. Configure your environment variables in `.env` (see Configuration section)

5. Build the project:
```bash
npm run build
```

## Configuration

Create a `.env` file in the root directory with the following variables:

### AMI Connection Settings
```env
AMI_HOST=192.168.1.100          # Asterisk server IP address
AMI_PORT=5038                   # AMI port (default: 5038)
AMI_USERNAME=admin              # AMI username
AMI_SECRET=secret123           # AMI password/secret
AMI_RECONNECT_INTERVAL=5000     # Reconnection delay in ms (default: 5000)
AMI_RECONNECT_MAX_ATTEMPTS=-1   # Max reconnection attempts (-1 = unlimited)
```

### Webhook Settings
```env
WEBHOOK_URL=https://your-crm.com/api/webhooks/ami
WEBHOOK_TIMEOUT=10000           # Request timeout in ms (default: 10000)
WEBHOOK_RETRY_MAX_ATTEMPTS=5    # Max retry attempts (default: 5)
WEBHOOK_RETRY_INITIAL_DELAY=1000 # Initial retry delay in ms (default: 1000)
WEBHOOK_RETRY_MAX_DELAY=30000   # Maximum retry delay in ms (default: 30000)
WEBHOOK_RETRY_MULTIPLIER=2      # Exponential backoff multiplier (default: 2)
```

### HTTP Server Settings
```env
SERVER_ENABLED=true             # Enable HTTP server for health checks
SERVER_PORT=3000                # HTTP server port (default: 3000)
API_TOKEN=your-secret-token-here # API token for click2call authentication
```

### Logging
```env
LOG_LEVEL=info                  # Log level: debug, info, warn, error (default: info)
LOG_FILE_ENABLED=true           # Enable file logging (default: true)
LOG_FILE_DIRECTORY=./logs       # Log file directory (default: ./logs)
LOG_RETENTION_DAYS=90           # Number of days to keep log files (default: 90)
```

## Usage

### Development Mode
```bash
npm run dev
```

### Production Mode
```bash
# Build the project
npm run build

# Start with PM2
pm2 start ecosystem.config.js

# View logs
pm2 logs ami-listener

# Stop the service
pm2 stop ami-listener

# Restart the service
pm2 restart ami-listener
```

### PM2 Commands
```bash
# Start
pm2 start ecosystem.config.js

# Stop
pm2 stop ami-listener

# Restart
pm2 restart ami-listener

# Delete
pm2 delete ami-listener

# View status
pm2 status

# View logs
pm2 logs ami-listener

# Monitor
pm2 monit
```

## Project Structure

```
nodejs-sangoma-ami-listener/
├── src/
│   ├── index.ts          # Main entry point with graceful shutdown
│   ├── ami.ts            # AMI connection and event handling
│   ├── webhook.ts        # Webhook delivery with retry logic
│   ├── logger.ts         # Structured JSON logging
│   ├── config.ts         # Environment configuration
│   └── utils.ts          # Utility functions (timestamp formatting)
├── dist/                 # Compiled JavaScript (generated)
├── logs/                 # PM2 log files (generated)
├── .env                  # Environment variables (create from .env.example)
├── .env.example          # Environment variables template
├── .gitignore
├── package.json
├── tsconfig.json
├── ecosystem.config.js   # PM2 configuration
└── README.md
```

## Event Processing

The service listens to AMI events and forwards them directly to webhook endpoints:

| AMI Event | Description | Merging Behavior |
|-----------|-------------|-----------------|
| DialBegin | Call is ringing | Sent immediately (no merging) |
| BridgeEnter | Call answered (bridged) | **Merged** with same `linkedid` before sending |
| Hangup | Call ended | **Merged** with same `linkedid` before sending |

### Event Merging (Hangup & BridgeEnter)

For outbound calls, Asterisk generates two separate Hangup/BridgeEnter events (one for the extension channel and one for the trunk channel) with the same `linkedid`. The service automatically merges these events into a single webhook payload containing complete caller and callee information.

**How it works:**
1. When a Hangup or BridgeEnter event is received, the service checks if there's already a pending event with the same `linkedid`
2. If found, both events are merged into one with:
   - `channels`: Array containing information from both channels
   - `caller`: Information from the extension/internal channel (context: `from-internal`)
   - `callee`: Information from the external/trunk channel (context: `from-trunk`)
   - `hotline`: Hotline number from `connectedlinenum` of the trunk channel
3. If no matching event is found within 2 seconds, the single event is sent as-is

**Merged Event Structure:**
- **Caller**: Identified by context containing "internal" → `calleridnum` is the extension number
- **Callee**: Identified by context containing "trunk" → `calleridnum` is the external phone number
- **Hotline**: `connectedlinenum` from the trunk channel is the hotline number displayed to the callee

### Event Filtering

The service automatically filters out events based on the following criteria:

1. **Channel Filtering**: 
   - Events with channels starting with `Local/` or `Macro/` are skipped
   - For `DialBegin` events: destination channels starting with `Local/` or `Macro/` are also skipped

2. **Extension Filtering**:
   - Events with extension `s` (start extension) are skipped
   - Events with extension `h` (hangup extension) are skipped

3. **Data Sanitization**: 
   - The `incomingData` field is automatically removed from all events
   - A `timestamp` field (Asia/Ho_Chi_Minh timezone, UTC+7) is automatically added to each event

4. **Raw Format**: `DialBegin` events are forwarded in their original AMI format (no normalization). `Hangup` and `BridgeEnter` events are merged when they have the same `linkedid`.

## Webhook Payload Format

### DialBegin Events

`DialBegin` events are sent as POST requests with the original AMI event format (no merging):

```json
{
  "Event": "DialBegin",
  "Privilege": "call,all",
  "Channel": "SIP/1001-00000001",
  "ChannelState": "4",
  "ChannelStateDesc": "Ring",
  "CallerIDNum": "1001",
  "CallerIDName": "John Doe",
  "ConnectedLineNum": "1002",
  "ConnectedLineName": "Jane Doe",
  "Uniqueid": "1234567890.123",
  "Destination": "SIP/1002-00000002",
  "Context": "from-internal",
  "Exten": "1002",
  "Priority": "1",
  "timestamp": "2024-01-15T10:30:00.000+07:00"
}
```

### Merged Hangup & BridgeEnter Events

For outbound calls, `Hangup` and `BridgeEnter` events with the same `linkedid` are automatically merged into a single webhook payload:

```json
{
  "event": "Hangup",
  "privilege": "call,all",
  "linkedid": "1769163211.30169",
  "cause": "16",
  "cause_txt": "Normal Clearing",
  "timestamp": "2026-01-23T17:13:51.430+07:00",
  "channels": [
    {
      "channel": "SIP/VNPT-0000255a",
      "calleridnum": "0938146818",
      "calleridname": "CID:02439369558",
      "connectedlinenum": "02439369558",
      "connectedlinename": "",
      "context": "from-trunk",
      "uniqueid": "1769163216.30180"
    },
    {
      "channel": "SIP/244-00002559",
      "calleridnum": "244",
      "calleridname": "Cloudgo",
      "connectedlinenum": "244",
      "connectedlinename": "Cloudgo",
      "context": "from-internal",
      "uniqueid": "1769163212.30171"
    }
  ],
  "caller": {
    "channel": "SIP/244-00002559",
    "calleridnum": "244",
    "calleridname": "Cloudgo",
    "context": "from-internal",
    "uniqueid": "1769163212.30171"
  },
  "callee": {
    "channel": "SIP/VNPT-0000255a",
    "calleridnum": "0938146818",
    "calleridname": "CID:02439369558",
    "context": "from-trunk",
    "uniqueid": "1769163216.30180"
  },
  "hotline": {
    "number": "02439369558",
    "name": ""
  }
}
```

**Merged Event Fields:**
- `channels`: Array of both channel information (extension and trunk)
- `caller`: Caller information (extension/internal channel with context `from-internal`)
  - `calleridnum`: Extension number (e.g., "244")
- `callee`: Callee information (external/trunk channel with context `from-trunk`)
  - `calleridnum`: External phone number (e.g., "0938146818")
- `hotline`: Hotline number displayed to the callee
  - `number`: Hotline number from `connectedlinenum` of trunk channel (e.g., "02439369558")

**Note**: 
- The `incomingData` field is automatically removed from all events
- A `timestamp` field is automatically added to each event in Asia/Ho_Chi_Minh timezone (UTC+7) format: `2024-01-15T10:30:00.000+07:00`
- `DialBegin` events are forwarded in their original AMI format (no normalization)
- `Hangup` and `BridgeEnter` events are merged when they have the same `linkedid` (typically for outbound calls)
- If a matching event is not found within 2 seconds, the single event is sent as-is

### Event Examples

#### `DialBegin`
Triggered when a call starts ringing.
```json
{
  "Event": "DialBegin",
  "Privilege": "call,all",
  "Channel": "SIP/1001-00000001",
  "ChannelState": "4",
  "ChannelStateDesc": "Ring",
  "CallerIDNum": "1001",
  "CallerIDName": "John Doe",
  "Uniqueid": "1234567890.123",
  "Destination": "SIP/1002-00000002",
  "DestChannel": "SIP/1002-00000002",
  "Context": "from-internal",
  "Exten": "1002",
  "timestamp": "2024-01-15T10:30:01.000+07:00"
}
```

#### `BridgeEnter` (Merged for Outbound Calls)
Triggered when a call is answered (bridged). For outbound calls, this event is merged with the matching event from the trunk channel.

**Merged Format (Outbound Call):**
```json
{
  "event": "BridgeEnter",
  "privilege": "call,all",
  "linkedid": "1769163211.30169",
  "timestamp": "2026-01-23T17:13:05.000+07:00",
  "channels": [
    {
      "channel": "SIP/244-00002559",
      "calleridnum": "244",
      "calleridname": "Cloudgo",
      "context": "from-internal",
      "uniqueid": "1769163212.30171"
    },
    {
      "channel": "SIP/VNPT-0000255a",
      "calleridnum": "0938146818",
      "calleridname": "CID:02439369558",
      "context": "from-trunk",
      "uniqueid": "1769163216.30180"
    }
  ],
  "caller": {
    "channel": "SIP/244-00002559",
    "calleridnum": "244",
    "calleridname": "Cloudgo",
    "context": "from-internal",
    "uniqueid": "1769163212.30171"
  },
  "callee": {
    "channel": "SIP/VNPT-0000255a",
    "calleridnum": "0938146818",
    "calleridname": "CID:02439369558",
    "context": "from-trunk",
    "uniqueid": "1769163216.30180"
  },
  "hotline": {
    "number": "02439369558",
    "name": ""
  }
}
```

**Single Event Format (if no match found within 2 seconds):**
```json
{
  "Event": "BridgeEnter",
  "Privilege": "call,all",
  "Channel": "SIP/1001-00000001",
  "BridgeUniqueid": "bridge-123",
  "CallerIDNum": "1001",
  "CallerIDName": "John Doe",
  "ConnectedLineNum": "1002",
  "ConnectedLineName": "Jane Doe",
  "Uniqueid": "1234567890.123",
  "timestamp": "2024-01-15T10:30:05.000+07:00"
}
```

#### `Hangup` (Merged for Outbound Calls)
Triggered when a call ends. For outbound calls, this event is merged with the matching event from the trunk channel.

**Merged Format (Outbound Call):**
```json
{
  "event": "Hangup",
  "privilege": "call,all",
  "linkedid": "1769163211.30169",
  "cause": "16",
  "cause_txt": "Normal Clearing",
  "timestamp": "2026-01-23T17:13:51.430+07:00",
  "channels": [
    {
      "channel": "SIP/244-00002559",
      "calleridnum": "244",
      "calleridname": "Cloudgo",
      "context": "from-internal",
      "uniqueid": "1769163212.30171"
    },
    {
      "channel": "SIP/VNPT-0000255a",
      "calleridnum": "0938146818",
      "calleridname": "CID:02439369558",
      "connectedlinenum": "02439369558",
      "context": "from-trunk",
      "uniqueid": "1769163216.30180"
    }
  ],
  "caller": {
    "channel": "SIP/244-00002559",
    "calleridnum": "244",
    "calleridname": "Cloudgo",
    "context": "from-internal",
    "uniqueid": "1769163212.30171"
  },
  "callee": {
    "channel": "SIP/VNPT-0000255a",
    "calleridnum": "0938146818",
    "calleridname": "CID:02439369558",
    "context": "from-trunk",
    "uniqueid": "1769163216.30180"
  },
  "hotline": {
    "number": "02439369558",
    "name": ""
  }
}
```

**Single Event Format (if no match found within 2 seconds):**
```json
{
  "Event": "Hangup",
  "Privilege": "call,all",
  "Channel": "SIP/1001-00000001",
  "Uniqueid": "1234567890.123",
  "Cause": "16",
  "CauseTxt": "Normal Clearing",
  "Duration": "330",
  "CallerIDNum": "1001",
  "CallerIDName": "John Doe",
  "timestamp": "2024-01-15T10:35:30.000+07:00"
}
```

**Important Notes:**
- `DialBegin` events are forwarded in their **original AMI format** (no normalization, no merging)
- `Hangup` and `BridgeEnter` events are **automatically merged** when they have the same `linkedid` (typically for outbound calls)
- The merged events include `caller`, `callee`, `hotline`, and `channels` fields for complete call information
- If a matching event is not found within 2 seconds, the single event is sent as-is
- The `incomingData` field is **automatically removed** from all events
- A `timestamp` field is **automatically added** to each event (Asia/Ho_Chi_Minh timezone, UTC+7)
- Events with channels starting with `Local/` or `Macro/` are **automatically filtered out**
- For `DialBegin` events, destination channels starting with `Local/` or `Macro/` are also filtered out
- Events with extension `s` (start) or `h` (hangup) are **automatically filtered out**
- Only `DialBegin`, `BridgeEnter`, and `Hangup` events are processed (MixMonitorStart and MixMonitorStop are not supported)
- Timestamps in application logs use **Asia/Ho_Chi_Minh timezone (UTC+7)**

## Health Check Endpoints

When `SERVER_ENABLED=true`, the service exposes HTTP endpoints:

### GET /health
Returns service health status.
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000+07:00",
  "uptime": 3600
}
```

### GET /ready
Returns service readiness status (useful for Kubernetes liveness/readiness probes).
```json
{
  "status": "ready",
  "timestamp": "2024-01-15T10:30:00.000+07:00"
}
```

### POST /api/click2call
Initiates a click2call session. Requires authentication via Bearer token.

**Authentication:**
- Header: `Authorization: Bearer <API_TOKEN>`
- Token must match the `API_TOKEN` configured in environment variables

**Request Body:**
```json
{
  "extension": "1001",
  "phoneNumber": "0123456789"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "message": "Call initiated successfully",
  "data": {
    "extension": "1001",
    "phoneNumber": "0123456789",
    "actionId": "1234567890.123"
  }
}
```

**Error Responses:**

*401 Unauthorized* - Missing or invalid token:
```json
{
  "success": false,
  "error": "Authentication token required",
  "message": "Please provide a valid API token in Authorization header"
}
```

*400 Bad Request* - Missing or invalid parameters:
```json
{
  "success": false,
  "error": "Missing parameter",
  "message": "Extension is required"
}
```

*500 Internal Server Error* - Call initiation failed:
```json
{
  "success": false,
  "error": "Call initiation failed",
  "message": "Failed to initiate call"
}
```

**Example cURL Request:**
```bash
curl -X POST http://localhost:3000/api/click2call \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-token-here" \
  -d '{
    "extension": "1001",
    "phoneNumber": "0123456789"
  }'
```

**Notes:**
- The extension must be numeric
- Phone number can include international format (with + prefix)
- The service will first call the extension, then when answered, dial the phone number
- The call is initiated asynchronously and will not block the API response

## Logging

The service uses structured JSON logging. Logs are written to:
- Console (stdout)
- Daily log files: `./logs/YYYY-MM-DD.log` (e.g., `2024-01-15.log`)
- PM2 log files: `./logs/out.log`, `./logs/error.log`, `./logs/combined.log`

### Log File Features

- **Daily Rotation**: Log files are created per day with format `YYYY-MM-DD.log`
- **Automatic Cleanup**: Old log files older than the retention period (default: 90 days) are automatically deleted
- **Configurable**: Log file directory and retention days can be configured via environment variables
- **Non-blocking**: File writes are asynchronous and won't block the main application flow

### Log Format

All logs are in JSON format with timestamps in Asia/Ho_Chi_Minh timezone (UTC+7):
```json
{
  "timestamp": "2024-01-15T10:30:00.000+07:00",
  "level": "info",
  "message": "Connected to AMI",
  "host": "192.168.1.100",
  "port": 5038
}
```

### Log File Configuration

- `LOG_FILE_ENABLED`: Enable/disable file logging (default: `true`)
- `LOG_FILE_DIRECTORY`: Directory where log files are stored (default: `./logs`)
- `LOG_RETENTION_DAYS`: Number of days to keep log files (default: `90`)

The cleanup process runs automatically when a new day starts (when the log file name changes).

## Reliability Features

### Auto-Reconnect
- Automatically reconnects to AMI on disconnect
- Configurable reconnection interval and max attempts
- Exponential backoff for reconnection attempts

### Webhook Retry
- Exponential backoff retry mechanism
- Configurable max attempts, initial delay, max delay, and multiplier
- Idempotency using `event:uniqueid` key to prevent duplicate deliveries

### Graceful Shutdown
- Handles SIGTERM and SIGINT signals
- Closes HTTP server gracefully
- Disconnects from AMI cleanly
- Waits for in-flight webhooks to complete

## Troubleshooting

### Connection Issues
- Verify AMI credentials in `.env`
- Check firewall rules for AMI port (default: 5038)
- Ensure AMI is enabled in Asterisk configuration
- Check AMI user permissions in `manager.conf`

### Webhook Delivery Issues
- Verify `WEBHOOK_URL` is correct and accessible
- Check webhook endpoint logs for errors
- Review retry configuration if webhooks are failing
- Check network connectivity to webhook endpoint

### PM2 Issues
- Check PM2 logs: `pm2 logs ami-listener`
- Verify PM2 is running: `pm2 status`
- Restart service: `pm2 restart ami-listener`

### Logs
- View real-time logs: `pm2 logs ami-listener`
- Check log files in `./logs/` directory
- Set `LOG_LEVEL=debug` for detailed debugging

## Development

### Scripts
- `npm run build` - Compile TypeScript to JavaScript
- `npm run start` - Run compiled JavaScript
- `npm run dev` - Run TypeScript directly with ts-node

### TypeScript
The project uses TypeScript with strict mode enabled. Source files are in `src/` and compiled output goes to `dist/`.

## License

ISC

## Support

For issues and questions, please open an issue on the GitHub repository.
