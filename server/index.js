const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

io.on('connection', (socket) => {
    console.log('Nuovo client connesso:', socket.id);

        // l'host chiede di creare una stanza
        socket.on('host-create-room', () => {
            const pin = generatePin();
            console.log('Stanza creata con PIN:', pin);
            socket.emit('room-created', { pin });
        });

        socket.on('disconnect', () => {
            console.log('Client disconnesso:', socket.id);
        });


    // funzione per generare un PIN a 6 cifre
    function generatePin() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }

    socket.on('disconnect', () => {
        console.log('Client disconnesso:', socket.id);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server avviato su http://localhost:${PORT}`);
});