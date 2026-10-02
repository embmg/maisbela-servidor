async function iniciarConexaoWhatsApp() {
  if (conectando) {
    console.log('Já existe uma conexão em andamento — ignorando chamada duplicada.');
    return;
  }
  conectando = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(PASTA_SESSAO);
    const { version } = await fetchLatestBaileysVersion();
    console.log('Usando versão do WhatsApp Web:', version);

    socketWhatsApp = makeWASocket({
      version,
      auth: state,
      logger: P({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['MaisBela', 'Chrome', '1.0.0'],
      // Habilita a renegociação de mensagens/chaves (evita acúmulo de Bad MAC)
      getMessage: async (key) => {
        return { conversation: '' };
      }
    });

    socketWhatsApp.ev.on('creds.update', saveCreds);

    socketWhatsApp.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;
        const jid = msg.key.remoteJid || '';
        if (jid.endsWith('@g.us')) continue;
        if (jid === 'status@broadcast') continue;
        if (jid.endsWith('@broadcast')) continue;

        const textoRecebido =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.buttonsResponseMessage?.selectedButtonId ||
          msg.message.listResponseMessage?.singleSelectReply?.selectedRowId ||
          '';

        if (!textoRecebido) continue;

        const acao = detectarAcao(textoRecebido);
        if (!acao) continue;

        const telefone = jid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
        if (!telefone) continue;

        console.log(`Resposta de ${telefone}: ${acao.toUpperCase()}`);
        respostasPendentes.push({ telefone, acao, timestamp: Date.now() });
        limparRespostasAntigas();
      }
    });

    socketWhatsApp.ev.on('connection.update', async (atualizacao) => {
      const { connection, lastDisconnect, qr } = atualizacao;

      if (qr) {
        ultimoQrCodeBase64 = await qrcode.toDataURL(qr);
        statusConexao = 'aguardando_qr';
        console.log('Novo QR gerado — acesse /qr (expira em ~60s).');
      }

      if (connection === 'open') {
        statusConexao = 'conectado';
        ultimoQrCodeBase64 = null;
        conectando = false;
        console.log('✅ Conectado ao WhatsApp!');
      }

      if (connection === 'close') {
        statusConexao = 'desconectado';
        conectando = false;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const erroMensagem = lastDisconnect?.error?.message || '';
        
        const foiLogout = statusCode === DisconnectReason.loggedOut;
        const erroChaveOuMac = erroMensagem.includes('Bad MAC') || statusCode === 401;

        console.log('Conexão fechada. Motivo:', statusCode, '| Erro:', erroMensagem);

        // Se foi logout manual OU se a chave da sessão foi corrompida (Bad MAC)
        if (foiLogout || erroChaveOuMac) {
          console.log('Sessão inválida ou corrompida — limpando sessão e gerando novo QR...');
          try { fs.rmSync(PASTA_SESSAO, { recursive: true, force: true }); } catch (_) {}
          statusConexao = 'iniciando';
          ultimoQrCodeBase64 = null;
          setTimeout(iniciarConexaoWhatsApp, 1000);
        } else if (statusCode === DisconnectReason.restartRequired) {
          iniciarConexaoWhatsApp();
        } else {
          setTimeout(iniciarConexaoWhatsApp, 3000);
        }
      }
    });
  } catch (e) {
    conectando = false;
    console.error('Erro ao iniciar conexão:', e);
  }
}
