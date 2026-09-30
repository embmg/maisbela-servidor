// Servidor do MaisBela: mantém uma conexão com o WhatsApp e envia mensagens
// automaticamente quando o app Android pede, sem precisar abrir o WhatsApp.

const express = require('express');
const qrcode = require('qrcode');
const P = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());

// Chave secreta que o app Android precisa enviar para poder mandar mensagens.
// Configure isso como Variável de Ambiente na Render (passo mais à frente),
// em vez de deixar fixo aqui no código.
const CHAVE_SECRETA = process.env.CHAVE_SECRETA || 'troque-esta-chave-1234';

let socketWhatsApp = null;
let ultimoQrCodeBase64 = null;
let statusConexao = 'iniciando'; // iniciando | aguardando_qr | conectado | desconectado

async function iniciarConexaoWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  socketWhatsApp = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false
  });

  socketWhatsApp.ev.on('creds.update', saveCreds);

  socketWhatsApp.ev.on('connection.update', async (atualizacao) => {
    const { connection, lastDisconnect, qr } = atualizacao;

    if (qr) {
      ultimoQrCodeBase64 = await qrcode.toDataURL(qr);
      statusConexao = 'aguardando_qr';
      console.log('Novo QR code gerado — acesse /qr no navegador para escanear.');
    }

    if (connection === 'open') {
      statusConexao = 'conectado';
      ultimoQrCodeBase64 = null;
      console.log('✅ Conectado ao WhatsApp com sucesso!');
    }

    if (connection === 'close') {
      statusConexao = 'desconectado';
      const motivo = lastDisconnect?.error?.output?.statusCode;
      const deveReconectar = motivo !== DisconnectReason.loggedOut;
      console.log('Conexão fechada. Motivo:', motivo, '| Vai reconectar:', deveReconectar);
      if (deveReconectar) {
        iniciarConexaoWhatsApp();
      }
    }
  });
}

iniciarConexaoWhatsApp();

// Página simples para você escanear o QR code pelo navegador do celular.
app.get('/qr', (req, res) => {
  if (statusConexao === 'conectado') {
    return res.send('<h2>✅ Já está conectado ao WhatsApp!</h2>');
  }
  if (!ultimoQrCodeBase64) {
    return res.send('<h2>Aguardando gerar o QR code... atualize a página em alguns segundos.</h2>');
  }
  res.send(`
    <html>
      <body style="text-align:center; font-family: sans-serif;">
        <h2>Escaneie este código com o WhatsApp do salão</h2>
        <p>WhatsApp > Aparelhos conectados > Conectar um aparelho</p>
        <img src="${ultimoQrCodeBase64}" style="width:300px;" />
      </body>
    </html>
  `);
});

// Endpoint que o app Android chama para mandar mensagem de verdade, em segundo plano.
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

// A Render "cutuca" esse endereço para saber se o serviço está de pé — e é
// esse mesmo endereço que o UptimeRobot vai chamar a cada 5 minutos.
app.get('/status', (req, res) => {
  res.json({ status: statusConexao });
});

// IMPORTANTE: a Render define automaticamente a porta certa pela variável PORT.
const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
  console.log(`Servidor do MaisBela rodando na porta ${PORTA}`);
});
