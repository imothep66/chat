const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const fs = require('fs'); // Para manipulação de arquivos no servidor
const multer = require('multer'); // Para upload de arquivos via HTTP POST, se necessário

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Permite conexões de qualquer origem (para testar em IPs locais)
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e8 // 100 MB - Aumenta o limite para envio de dados (incluindo arquivos)
});

const UPLOADS_DIR = path.join(__dirname, 'uploads'); // Diretório para salvar arquivos
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR);
}

// Configuração do Multer para lidar com upload de arquivos (se você quiser usar POST para arquivos grandes)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Serve arquivos estáticos (o index.html e os arquivos enviados)
app.use(express.static(__dirname)); // Serve o index.html da raiz do projeto
app.use('/uploads', express.static(UPLOADS_DIR)); // Serve os arquivos do diretório 'uploads'

// Mapa para armazenar os sockets conectados e facilitar o pareamento 1x1
const connectedSockets = new Map(); // key: socket.id, value: { peerId: other_socket_id, username: '...' }

io.on('connection', (socket) => {
    console.log(`Usuário conectado: ${socket.id}`);

    // Adiciona o novo socket ao pool de conectados
    // Lógica simples de pareamento: os 2 primeiros que conectam são um par
    // Em um app real, você teria um sistema de lobby, convites, etc.
    if (connectedSockets.size < 2) {
        connectedSockets.set(socket.id, { peerId: null, username: `Usuário ${socket.id.substring(0, 4)}` });

        if (connectedSockets.size === 2) {
            const [id1, data1] = Array.from(connectedSockets)[0];
            const [id2, data2] = Array.from(connectedSockets)[1];

            // Define o peer um do outro
            connectedSockets.get(id1).peerId = id2;
            connectedSockets.get(id2).peerId = id1;

            // Notifica os dois usuários que estão pareados
            io.to(id1).emit('chat ready', { peerId: id2, peerUsername: connectedSockets.get(id2).username });
            io.to(id2).emit('chat ready', { peerId: id1, peerUsername: connectedSockets.get(id1).username });
            console.log(`Pareamento completo: ${id1} <-> ${id2}`);
        } else {
            // Primeiro usuário conectado, aguardando o segundo
            socket.emit('waiting for peer', 'Aguardando o outro usuário para iniciar o chat 1x1...');
        }
    } else {
        // Mais de 2 usuários, este não fará parte do chat 1x1 atual
        console.log(`Usuário ${socket.id} não faz parte do chat 1x1 atual (limite de 2).`);
        socket.emit('system message', 'No momento, o chat está com capacidade máxima (2 usuários). Tente novamente mais tarde.');
        socket.disconnect(true);
        return;
    }

    // Lida com mensagens de texto
    socket.on('chat message', (msg) => {
        const senderInfo = connectedSockets.get(socket.id);
        if (senderInfo && senderInfo.peerId) {
            console.log(`Mensagem de ${socket.id} para ${senderInfo.peerId}: ${msg.text}`);
            io.to(senderInfo.peerId).emit('chat message', {
                senderId: socket.id,
                username: senderInfo.username,
                text: msg.text,
                timestamp: msg.timestamp
            });
        }
    });

    // Lida com o envio de arquivos via Socket.IO
    socket.on('file message', ({ filename, fileBuffer, fileType, timestamp }) => {
        const senderInfo = connectedSockets.get(socket.id);
        if (senderInfo && senderInfo.peerId) {
            console.log(`Arquivo de ${socket.id} para ${senderInfo.peerId}: ${filename}`);
            // Salva o arquivo temporariamente no servidor (opcional, mas bom para referência)
            const filePath = path.join(UPLOADS_DIR, Date.now() + '-' + filename);
            fs.writeFile(filePath, fileBuffer, (err) => {
                if (err) {
                    console.error('Erro ao salvar arquivo no servidor:', err);
                    // Avisar o cliente sobre o erro, se necessário
                }
            });

            // Envia o arquivo para o outro usuário
            io.to(senderInfo.peerId).emit('file message', {
                senderId: socket.id,
                username: senderInfo.username,
                filename: filename,
                fileBuffer: fileBuffer, // Enviando o buffer do arquivo
                fileType: fileType,
                timestamp: timestamp
            });
        }
    });

    // Lida com a desconexão
    socket.on('disconnect', () => {
        console.log(`Usuário desconectado: ${socket.id}`);
        const disconnectedPeerId = connectedSockets.get(socket.id)?.peerId;
        connectedSockets.delete(socket.id);

        if (disconnectedPeerId && connectedSockets.has(disconnectedPeerId)) {
            io.to(disconnectedPeerId).emit('peer disconnected', 'O outro usuário desconectou do chat.');
            // Remove o par também se a lógica for de par fixo
            connectedSockets.delete(disconnectedPeerId);
            console.log(`Par ${disconnectedPeerId} também removido.`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor de chat rodando em http://localhost:${PORT}`);
    console.log(`Abra http://localhost:${PORT} em duas abas/navegadores para testar o chat 1x1.`);
    console.log('Para conectar de outro computador na rede local, use o IP deste computador, por exemplo: http://192.168.1.10:3000');
});