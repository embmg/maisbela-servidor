// Servidor do MaisBela: mantém uma conexão com o WhatsApp, envia mensagens
// automaticamente, "escuta" as respostas das clientes e atualiza o Firebase
// quando alguém clica nos links de confirmação/cancelamento.

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

// ===================== CONFIGURAÇÃO FIREBASE =====================
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'espacomaisbelasalao';
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyBvMiIOorcHxZoKNmiGA2L7kTzx-oDexZA';
// ================================================================

let socketWhatsApp = null;
let ultimoQrCodeBase64 = null;
let statusConexao = 'iniciando';
let ultimoMotivoDesconexao = '';
let tentandoReconectar = false;

let respostasPendentes = [];

function normalizarTexto(texto) {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
}

// ===================== FUNÇÃO QUE ATUALIZA O FIREBASE =====================
async function atualizarStatusNoFirebase(idAgendamento, novoStatus) {
  if (!FIREBASE_API_KEY) {
    console.error('⚠️ FIREBASE_API_KEY não configurada nas variáveis de ambiente.');
    return false;
  }

  const url =
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}` +
    `/databases/(default)/documents/agendamentos/${idAgendamento}` +
    `?updateMask.fieldPaths=status&key=${FIREBASE_API_KEY}`;

  const corpo = {
    fields: {
      status: { stringValue: novoStatus }
    }
  };

  try {
    const resposta = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo)
    });

    if (!resposta.ok) {
      const texto = await resposta.text();
      console.error(`❌ Firebase respondeu ${resposta.status}: ${texto}`);
      return false;
    }

    console.log(`✅ Firebase: agendamento ${idAgendamento} → "${novoStatus}"`);
    return true;
  } catch (erro) {
    console.error('❌ Erro ao chamar Firebase:', erro);
    return false;
  }
}
// ==========================================================================

async function iniciarConexaoWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO);

  const { version } = await fetchLatestBaileysVersion();
  console.log('Usando versão do WhatsApp Web:', version);

  socketWhatsApp = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['MaisBela', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false
  });

  socketWhatsApp.ev.on('creds.update', saveCreds);

  socketWhatsApp.ev.on('messages.upsert', (evento) => {
    for (const msg of evento.messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;

      const textoRecebido =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';

      if (!textoRecebido) continue;

      const textoNormalizado = normalizarTexto(textoRecebido);
      const telefone = msg.key.remoteJid.replace('@s.whatsapp.net', '');

      let acao = null;
      if (textoNormalizado.includes('CONFIRMAR')) acao = 'confirmar';
      else if (textoNormalizado.includes('CANCELAR')) acao = 'cancelar';

      if (acao) {
        console.log(`💬 Resposta recebida de ${telefone}: ${acao.toUpperCase()}`);
        respostasPendentes.push({ telefone, acao, timestamp: Date.now() });
      }
    }
  });

  socketWhatsApp.ev.on('connection.update', async (atualizacao) => {
    const { connection, lastDisconnect, qr } = atualizacao;

    if (qr) {
      ultimoQrCodeBase64 = await qrcode.toDataURL(qr);
      statusConexao = 'aguardando_qr';
      console.log('📱 Novo QR Code disponível em /qr');
    }

    if (connection === 'open') {
      statusConexao = 'conectado';
      ultimoQrCodeBase64 = null;
      tentandoReconectar = false;
      console.log('✅ Conectado ao WhatsApp com sucesso!');
    }

    if (connection === 'close') {
      const motivo = lastDisconnect?.error?.output?.statusCode;
      ultimoMotivoDesconexao = String(motivo || 'desconhecido');
      console.log('🔴 Conexão encerrada. Código:', motivo);

      if (motivo === DisconnectReason.loggedOut) {
        console.log('Logout detectado — limpando sessão antiga e gerando novo QR code...');
        try {
          fs.rmSync(PASTA_SESSAO, { recursive: true, force: true });
        } catch (e) {
          console.error('Erro ao limpar pasta de sessão:', e);
        }
        statusConexao = 'iniciando';
        ultimoQrCodeBase64 = null;
        iniciarConexaoWhatsApp();
        return;
      }

      if (motivo === DisconnectReason.connectionReplaced) {
        console.log('⚠️ Conexão substituída por outro aparelho. Parando de tentar automaticamente.');
        console.log('👉 Remova TODOS os aparelhos em WhatsApp > Aparelhos conectados, depois acesse /reconectar');
        statusConexao = 'substituido';
        return;
      }

      if (tentandoReconectar) return;
      tentandoReconectar = true;
      statusConexao = 'desconectado';
      setTimeout(() => {
        tentandoReconectar = false;
        iniciarConexaoWhatsApp();
      }, 5000);
    }
  });
}

iniciarConexaoWhatsApp();

app.get('/qr', (req, res) => {
  if (statusConexao === 'conectado') {
    return res.send('<h2>✅ Já está conectado ao WhatsApp!</h2>');
  }
  if (statusConexao === 'substituido') {
    return res.send(`
      <h2>⚠️ Conexão foi substituída por outro aparelho.</h2>
      <p>1. Abra o WhatsApp do salão → Configurações → Aparelhos conectados</p>
      <p>2. Remova TODOS os aparelhos listados</p>
      <p>3. Acesse <a href="/reconectar">/reconectar</a></p>
    `);
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

app.get('/reconectar', async (req, res) => {
  try {
    fs.rmSync(PASTA_SESSAO, { recursive: true, force: true });
  } catch (e) {}
  statusConexao = 'iniciando';
  ultimoQrCodeBase64 = null;
  tentandoReconectar = false;
  await iniciarConexaoWhatsApp();
  res.send('<h2>🗑️ Pasta auth_info removida com sucesso.<br>Reiniciando conexão... acesse /qr em alguns segundos.</h2>');
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

app.get('/respostas', (req, res) => {
  const chaveRecebida = req.headers['x-chave-secreta'];
  if (chaveRecebida !== CHAVE_SECRETA) {
    return res.status(401).json({ sucesso: false, erro: 'Chave secreta inválida' });
  }

  const respostasParaEnviar = respostasPendentes;
  respostasPendentes = [];
  res.json({ respostas: respostasParaEnviar });
});

app.get('/status', (req, res) => {
  res.json({ status: statusConexao, ultimoMotivoDesconexao });
});

// ============================================================
// ROTAS DE CONFIRMAÇÃO E CANCELAMENTO (as páginas que a cliente vê)
// ============================================================

function paginaResposta(titulo, cor, emoji, mensagem) {
  return `
    <!DOCTYPE html>
    <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${titulo}</title>
      </head>
      <body style="margin:0; padding:0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #a78bcf 0%, #7c5cad 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center;">
        <div style="background: white; padding: 40px 30px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); max-width: 380px; margin: 20px; text-align: center;">
          <div style="font-size: 64px; margin-bottom: 10px;">${emoji}</div>
          <h1 style="color: ${cor}; font-size: 24px; margin: 10px 0 20px 0;">${titulo}</h1>
          <p style="color: #555; font-size: 16px; line-height: 1.5; margin: 0;">${mensagem}</p>
          <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; color: #999; font-size: 13px;">
            Espaço Mais Bela 💅
          </div>
        </div>
      </body>
    </html>
  `;
}

app.get('/confirmar', async (req, res) => {
  const id = req.query.id;
  console.log(`👉 Cliente clicou em CONFIRMAR para o agendamento ${id}`);

  if (!id) {
    return res.status(400).send(paginaResposta('Link inválido', '#f44336', '⚠️', 'O link não contém um agendamento válido.'));
  }

  const sucesso = await atualizarStatusNoFirebase(id, 'Confirmado');

  if (sucesso) {
    return res.send(paginaResposta(
      'Agendamento Confirmado!',
      '#4CAF50',
      '✅',
      'Seu horário está garantido. Aguardamos você com muito carinho!'
    ));
  } else {
    return res.status(500).send(paginaResposta(
      'Ops, algo deu errado',
      '#f44336',
      '😕',
      'Não conseguimos confirmar automaticamente. Por favor, responda esta mensagem com a palavra CONFIRMAR.'
    ));
  }
});

app.get('/cancelar', async (req, res) => {
  const id = req.query.id;
  console.log(`👉 Cliente clicou em CANCELAR para o agendamento ${id}`);

  if (!id) {
    return res.status(400).send(paginaResposta('Link inválido', '#f44336', '⚠️', 'O link não contém um agendamento válido.'));
  }

  const sucesso = await atualizarStatusNoFirebase(id, 'Cancelado');

  if (sucesso) {
    return res.send(paginaResposta(
      'Agendamento Cancelado',
      '#f44336',
      '❌',
      'Seu horário foi cancelado. Esperamos ver você em breve!'
    ));
  } else {
    return res.status(500).send(paginaResposta(
      'Ops, algo deu errado',
      '#f44336',
      '😕',
      'Não conseguimos cancelar automaticamente. Por favor, responda esta mensagem com a palavra CANCELAR.'
    ));
  }
});

// ============================================================

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
  console.log(`Servidor do MaisBela rodando na porta ${PORTA}`);
});
