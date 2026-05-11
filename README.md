# Nexus Server

Socket.io backend for Nexus chat app.

## Setup

```bash
cd nexus-server
npm install
npm start
```

Server runs on **http://localhost:3001**

## For multiplayer on your local network

1. Find your local IP:
   - Windows: run `ipconfig` → look for IPv4 address (e.g. 192.168.1.5)
   - Mac/Linux: run `ifconfig` → look for inet address

2. Start the server: `npm start`

3. In `nexus-app/src/App.jsx`, the SOCKET_URL is already set to auto-detect.
   Friends on the same WiFi open: `http://YOUR_IP:5173`

## Events reference

| Client → Server    | Payload                                      |
|--------------------|----------------------------------------------|
| auth               | { name, email, color, tag }                  |
| create_space       | { name, icon, color }                        |
| join_space         | spaceId                                      |
| leave_space        | spaceId                                      |
| send_message       | { channelId, spaceId, content }              |
| react              | { channelId, spaceId, msgId, emoji }         |
| typing_start       | { channelId, spaceId }                       |
| typing_stop        | { channelId, spaceId }                       |
| add_channel        | { spaceId, catId, channel }                  |
| update_status      | status string                                |

| Server → Client    | Payload                                      |
|--------------------|----------------------------------------------|
| init               | { user, spaces }                             |
| space_created      | space object                                 |
| space_joined       | { space, channelMessages }                   |
| new_message        | { channelId, msg }                           |
| reaction_update    | { channelId, msgId, reactions }              |
| typing_update      | { channelId, typing: string[] }              |
| channel_added      | { spaceId, catId, channel }                  |
| users_update       | User[]                                       |
| space_members_update | { spaceId, members: User[] }               |
