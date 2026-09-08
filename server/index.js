const express = require('express')
const http = require('http')
const {Server} = require('socket.io')
const path = require ('path')

const app = express();
const server = http.createServer(app);
const io = new Server(server);


app.use(express.static(path.join(__dirname, '..', 'public')));

io.on('connect', (socket) => {
    console.log('Nuovo client connesso', socket.id);

    socket.on('disconnect', () => {
        console.log('Client disconesso:', socket.id);
    });
});

const PORT = 3000;
app.listen(PORT, () =>{
    console.log(`Server avviato su http://localhost:${PORT}`);
});