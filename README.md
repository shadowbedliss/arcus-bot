# ARCUS: Operations Management Bot

ARCUS is a Discord bot designed for high-stakes operations management, featuring dynamic squad building, tactical role registration, and automated service records.

## Features
- **Dynamic Squads**: Automatically creates and manages squads (Alpha through India).
- **Tactical Roles**: Enforces role limits for Medics, Overwatch, and Demolitions.
- **Service Records**: Tracks attendance, promotions, and qualifications (BCT).
- **Mission Templates**: Allows rapid deployment of recurring operation types.
- **Integration**: Syncs with Discord Scheduled Events and provides automated reminders.

## Setup Instructions

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configuration**:
   Create a `.env` file in the root directory with your Discord application credentials:
   ```env
   TOKEN=your_bot_token
   CLIENT_ID=your_client_id
   ```

3. **Deploy Commands**:
   Run the deployment script to register slash commands with your guilds:
   ```bash
   node deploy-commands.js
   ```

4. **Start the Bot**:
   ```bash
   node index.js
   ```
