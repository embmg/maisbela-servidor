// Servidor do MaisBela: mantém uma conexão com o WhatsApp e envia mensagens
// automaticamente quando o app Android pede, sem precisar abrir o WhatsApp.

const fs = require('fs');
const express = require('express');
const qrcode = require('qrcode');
const P = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());

const CHAVE_SECRETA = process.env.CHAVE_SECRETA || 'troque-esta-chave-1234';
const PASTA_SESSAO = 'auth_info';

let socketWhatsApp = null;
let ultimoQrCodeBase64 = null;
let statusConexao = 'iniciando'; // iniciando | aguardando_qr | conectado | desconectado
let ultimoMotivoDesconexao = '';

async function iniciarConexaoWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO);

  const { version } = await fetchLatestBaileysVersion();
  console.log('Usando versão do WhatsApp Web:', version);

  socketWhatsApp = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['MaisBela', 'Chrome', '1.0.0']
  });

  socketWhatsApp.ev.on('creds.update', saveCreds);

  socketWhatsApp.ev.on('connection.update', async (atualizacao) => {
    const { connection, lastDisconnect, qr } = atualizacao;

    if (qr) {
      ultimoQrCodeBase64 = await qrcode.toDataURL(qr);
      statusConexao = 'aguardando_qr';
      console.log('Novo QR code gerado — acesse /qr e escaneie rápido (expira em ~60s).');
    }

    if (connection === 'open') {
      statusConexao = 'conectado';
      ultimoQrCodeBase64 = null;
      console.log('✅ Conectado ao WhatsApp com sucesso!');
    }

    if (connection === 'close') {
      statusConexao = 'desconectado';
      const motivo = lastDisconnect?.error?.output?.statusCode;
      ultimoMotivoDesconexao = String(motivo || 'desconhecido');
      const foiLogout = motivo === DisconnectReason.loggedOut;

      console.log('Conexão fechada. Motivo:', motivo, '| Foi logout:', foiLogout);

      if (foiLogout) {
        // A sessão antiga ficou inválida. Apaga os arquivos dela e já
        // reinicia sozinho para gerar um QR code novo automaticamente,
        // em vez de ficar parado esperando um comando que nunca chega.
        console.log('Logout detectado — limpando sessão antiga e gerando novo QR code...');
        try {
          fs.rmSync(PASTA_SESSAO, { recursive: true, force: true });
        } catch (e) {
          console.error('Erro ao limpar pasta de sessão:', e);
        }
        statusConexao = 'iniciando';
        ultimoQrCodeBase64 = null;
        iniciarConexaoWhatsApp();
      } else {
        // Qualquer outro tipo de desconexão (queda de rede, reinício do
        // servidor, etc.) — reconecta normalmente, mantendo a sessão.
        iniciarConexaoWhatsApp();
      }
    }
  });
}

iniciarConexaoWhatsApp();

// Página do QR code, com atualização automática a cada 15 segundos —
// assim você nunca escaneia um código já vencido por acidente.
app.get('/qr', (req, res) => {
  if (statusConexao === 'conectado') {
    return res.send('<h2>✅ Já está conectado ao WhatsApp!</h2>');
  }
  if (!ultimoQrCodeBase64) {
    return res.send(`
      <html>
        <head><meta http-equiv="refresh" content="5"></head>
        <body style="text-align:center; font-family: sans-serif;">
          <h2>Gerando QR code... esta página atualiza sozinha em 5 segundos.</h2>
        </body>
      </html>
    `);
  }
  res.send(`
    <html>
      <head><meta http-equiv="refresh" content="15"></head>
      <body style="text-align:center; font-family: sans-serif;">
        <h2>Escaneie este código com o WhatsApp do salão</h2>
        <p>WhatsApp > Aparelhos conectados > Conectar um aparelho</p>
        <img src="${ultimoQrCodeBase64}" style="width:300px;" />
        <p style="color:#888;">Esta página atualiza sozinha a cada 15 segundos com um QR novo, se precisar.</p>
      </body>
    </html>
  `);
});

// Botão de emergência: força limpar a sessão e gerar QR novo na hora,
// sem precisar esperar um logout real acontecer.
app.get('/reconectar', async (req, res) => {
  try {
    fs.rmSync(PASTA_SESSAO, { recursive: true, force: true });
  } catch (e) {}
  statusConexao = 'iniciando';
  ultimoQrCodeBase64 = null;
  await iniciarConexaoWhatsApp();
  res.send('<h2>Reiniciando conexão... acesse /qr em alguns segundos.</h2>');
});

app.post('/enviar', async (req, res) => {
  const chaveRecebida = req.headers['x-chave-secreta'];
  if (chaveRecebida !== CHAVE_SECRETA) {
    return res.status(401).json({ sucesso: false, erro: 'Chave secreta inválida' });
  }

  if (statusConexao !== 'conectado') {
    return res.status(503).json({ sucesso: false, erro: 'WhatsApp não está conectado no momento' });
  }

  const { telefone, mensagem } = req.body;
  if (!telefone || !mensagem) {
    return res.status(400).json({ sucesso: false, erro: 'Envie telefone e mensagem' });
  }

  try {
    const numeroFormatado = telefone.replace(/\D/g, '') + '@s.whatsapp.net';
    await socketWhatsApp.sendMessage(numeroFormatado, { text: mensagem });
    res.json({ sucesso: true });
  } catch (erro) {
    console.error('Erro ao enviar mensagem:', erro);
    res.status(500).json({ sucesso: false, erro: 'Falha ao enviar mensagem' });
  }
});

app.get('/status', (req, res) => {
  res.json({ status: statusConexao, ultimoMotivoDesconexao });
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
  console.log(`Servidor do MaisBela rodando na porta ${PORTA}`);
});
