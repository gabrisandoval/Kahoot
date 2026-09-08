const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

// NUOVO: memoria delle stanze attive
// rooms[pin] = { hostSocketId, players: { socketId: nickname } }
const rooms = {};

io.on('connection', (socket) => {
    console.log('Nuovo client connesso:', socket.id);

    socket.on('host-create-room', () => {
        const pin = generatePin();

        // NUOVO: salviamo la stanza in memoria
        rooms[pin] = {
            hostSocketId: socket.id,
            players: {}
        };

        console.log('Stanza creata con PIN:', pin);
        socket.emit('room-created', { pin });
    });

    // NUOVO: un giocatore prova a entrare in una stanza
    socket.on('player-join', ({ pin, nickname }) => {
        const room = rooms[pin];

        if (!room) {
            socket.emit('join-error', 'Stanza non trovata');
            return;
        }

        room.players[socket.id] = nickname;
        console.log(`${nickname} è entrato nella stanza ${pin}`);

        socket.emit('join-success', { pin, nickname });

        // Avvisiamo l'host che un nuovo giocatore è entrato
        const playerNames = Object.values(room.players);
        io.to(room.hostSocketId).emit('player-list-update', playerNames);
    });

    socket.on('disconnect', () => {
        console.log('Client disconnesso:', socket.id);
    });
});

function generatePin() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server avviato su http://localhost:${PORT}`);
});