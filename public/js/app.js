(function () {
  'use strict';

  const titles = {
    dashboard: 'Dashboard', processos: 'Processos', agenda: 'Agenda & Tarefas',
    clientes: 'Clientes', financeiro: 'Financeiro', timesheet: 'Timesheet', usuarios: 'Usuários',
    integracoes: 'Integrações',
  };
  const ROLE_LABEL = { socio: 'Sócio(a)', advogado: 'Advogado(a)', estagiario: 'Estagiário(a)' };
  const STATUS_TAG = {
    em_andamento: ['blue', 'Em andamento'],
    prazo_proximo: ['amber', 'Prazo próximo'],
    urgente: ['red', 'Urgente'],
    concluido: ['gray', 'Concluído'],
  };

  let ME = null;

  function fmtMoney(cents) {
    return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}`;
  }
  function tag(status) {
    const [cls, label] = STATUS_TAG[status] || ['gray', status];
    return `<span class="tag ${cls}">${label}</span>`;
  }
  function initials(name) {
    return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  }

  async function api(path, opts) {
    const r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
    if (r.status === 401) { window.location.href = '/'; throw new Error('nao_autenticado'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'erro');
    return data;
  }

  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + name).classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const item = document.querySelector(`.nav-item[data-view="${name}"]`);
    if (item) item.classList.add('active');
    document.getElementById('pageTitle').textContent = titles[name] || '';
    loadView(name);
  }

  function loadView(name) {
    if (name === 'dashboard') return loadDashboard();
    if (name === 'processos') return loadProcessos();
    if (name === 'agenda') return loadAgenda();
    if (name === 'clientes') return loadClientes();
    if (name === 'financeiro') return loadFinanceiro();
    if (name === 'timesheet') return loadTimesheet();
    if (name === 'usuarios') return loadUsuarios();
    if (name === 'integracoes') return loadIntegracoes();
  }

  function showDetail(id) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  }

  async function loadUsuarios() {
    const d = await api('/api/usuarios');
    document.getElementById('usuariosSub').textContent = `${d.usuarios.length} usuário(s) cadastrado(s)`;
    document.getElementById('usuariosTable').innerHTML = d.usuarios.map(u => `
      <tr>
        <td>${u.name}</td><td>${u.email}</td><td>${ROLE_LABEL[u.role] || u.role}</td>
        <td>${u.active ? '<span class="tag green">Ativo</span>' : '<span class="tag gray">Inativo</span>'}</td>
        <td>${u.active && u.id !== ME.user.id ? `<button class="btn-ghost deactivateBtn" data-id="${u.id}">Desativar</button>` : ''}</td>
      </tr>
    `).join('');
    document.querySelectorAll('.deactivateBtn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Desativar este usuário? Ele perderá o acesso imediatamente.')) return;
        await api(`/api/usuarios/${btn.dataset.id}/desativar`, { method: 'PATCH' });
        loadUsuarios();
      });
    });
  }

  async function loadDashboard() {
    const d = await api('/api/dashboard');
    const cards = [
      { v: d.processesCount, l: 'Processos ativos' },
      { v: d.deadlineSoon, l: 'Prazos nos próximos 5 dias' },
      { v: d.tasksToday, l: 'Tarefas pendentes' },
    ];
    if (d.faturamentoMes !== null) cards.push({ v: fmtMoney(d.faturamentoMes), l: 'Faturamento do mês' });
    document.getElementById('kpiGrid').innerHTML = cards.map(c => `
      <div class="kpi-card"><div class="kpi-value">${c.v}</div><div class="kpi-label">${c.l}</div></div>
    `).join('');
    document.getElementById('dashProcessTable').innerHTML = d.recentProcesses.map(p => `
      <tr><td class="mono">${p.cnj_number}</td><td>${p.client_name}</td><td>${p.phase || '—'}</td><td>${fmtDate(p.next_deadline)}</td><td>${tag(p.status)}</td></tr>
    `).join('') || '<tr><td colspan="5">Nenhum processo.</td></tr>';

    const t = await api('/api/tarefas');
    const pending = t.tarefas.filter(x => !x.done).slice(0, 6);
    document.getElementById('dashTasks').innerHTML = pending.map(x => `
      <div class="checklist-item"><input type="checkbox" data-id="${x.id}" class="taskToggle"><label>${x.title}</label><span class="prazo">${fmtDate(x.due_date)}</span></div>
    `).join('') || '<p style="color:var(--gray-600);font-size:13px;">Nenhuma tarefa pendente.</p>';
    bindTaskToggles();
  }

  async function loadProcessos() {
    const d = await api('/api/processos');
    document.getElementById('processosSub').textContent = `${d.processos.length} processo(s) visível(is) para o seu perfil`;
    document.getElementById('processosTable').innerHTML = d.processos.map(p => `
      <tr class="clickable-row" data-id="${p.id}">
        <td class="mono">${p.cnj_number}</td><td>${p.client_name}</td><td>${p.opposing_party || '—'}</td>
        <td>${p.area || '—'}</td><td>${p.phase || '—'}</td><td>${fmtDate(p.next_deadline)}</td>
        <td>${p.responsible_name}</td><td>${tag(p.status)}</td>
      </tr>
    `).join('') || '<tr><td colspan="8">Nenhum processo encontrado.</td></tr>';
    document.querySelectorAll('#processosTable tr[data-id]').forEach(tr => {
      tr.addEventListener('click', () => openProcessoDetalhe(Number(tr.dataset.id)));
    });
  }

  async function loadAgenda() {
    const [ag, ts] = await Promise.all([api('/api/agenda'), api('/api/tarefas')]);
    document.getElementById('agendaList').innerHTML = ag.agenda.map(e => `
      <div class="agenda-item"><div class="agenda-time">${e.event_time}</div>
        <div class="agenda-text"><b>${e.title}</b><span>${e.detail || ''}</span></div></div>
    `).join('') || '<p style="color:var(--gray-600);font-size:13px;">Nenhum compromisso.</p>';

    document.getElementById('tarefasList').innerHTML = ts.tarefas.map(x => `
      <div class="checklist-item ${x.done ? 'checked' : ''}"><input type="checkbox" data-id="${x.id}" class="taskToggle" ${x.done ? 'checked' : ''}>
        <label>${x.title}</label><span class="prazo">${fmtDate(x.due_date)}</span></div>
    `).join('') || '<p style="color:var(--gray-600);font-size:13px;">Nenhuma tarefa.</p>';
    bindTaskToggles();
  }

  let showingArquivados = false;

  async function loadClientes() {
    const d = await api('/api/clientes' + (showingArquivados ? '?arquivados=1' : ''));
    document.getElementById('clientesSub').textContent = showingArquivados
      ? `${d.clientes.length} cliente(s) arquivado(s)`
      : `${d.clientes.length} cliente(s) cadastrado(s)`;
    document.getElementById('clientesTable').innerHTML = d.clientes.map(c => `
      <tr class="clickable-row" data-id="${c.id}"><td>${c.name}${showingArquivados ? ' <span class="tag gray">arquivado</span>' : ''}</td><td>${c.type === 'PJ' ? 'Pessoa jurídica' : 'Pessoa física'}</td><td>${c.since || '—'}</td></tr>
    `).join('') || `<tr><td colspan="3">Nenhum cliente${showingArquivados ? ' arquivado' : ''}.</td></tr>`;
    document.querySelectorAll('#clientesTable tr[data-id]').forEach(tr => {
      tr.addEventListener('click', () => openClienteDetalhe(Number(tr.dataset.id)));
    });
  }

  async function loadFinanceiro() {
    const el = document.getElementById('financeiroBody');
    try {
      const d = await api('/api/financeiro');
      el.innerHTML = `
        <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:20px;">
          <div class="kpi-card"><div class="kpi-value">${fmtMoney(d.receitaMes)}</div><div class="kpi-label">Receita total</div></div>
          <div class="kpi-card"><div class="kpi-value">${fmtMoney(d.aReceber)}</div><div class="kpi-label">A receber</div></div>
          <div class="kpi-card"><div class="kpi-value">${fmtMoney(d.atrasado)}</div><div class="kpi-label">Em atraso</div></div>
        </div>
        <div class="card"><table><thead><tr><th>Cliente</th><th>Valor</th><th>Vencimento</th><th>Status</th></tr></thead>
        <tbody>${d.faturas.map(f => `<tr><td>${f.client_name}</td><td>${fmtMoney(f.amount_cents)}</td><td>${fmtDate(f.due_date)}</td><td>${tag(f.status === 'atrasada' ? 'urgente' : 'em_andamento')}</td></tr>`).join('')}</tbody></table></div>
      `;
    } catch (e) {
      el.innerHTML = '<div class="locked-msg"><b>Acesso restrito</b>O módulo Financeiro é visível apenas para sócios.</div>';
    }
  }

  async function loadTimesheet() {
    const d = await api('/api/timesheet');
    document.getElementById('timesheetTable').innerHTML = d.timesheet.map(t => `
      <tr><td>${fmtDate(t.entry_date)}</td><td>${t.user_name}</td><td>${t.description || '—'}</td><td class="mono">${Math.floor(t.minutes / 60)}h${String(t.minutes % 60).padStart(2, '0')}</td></tr>
    `).join('') || '<tr><td colspan="4">Nenhum lançamento.</td></tr>';
  }

  function bindTaskToggles() {
    document.querySelectorAll('.taskToggle').forEach(cb => {
      cb.addEventListener('change', async () => {
        await api(`/api/tarefas/${cb.dataset.id}/toggle`, { method: 'PATCH' });
        loadView(document.querySelector('.nav-item.active')?.dataset.view || 'dashboard');
      });
    });
  }

  // ---------- Modais simples ----------
  const backdrop = document.getElementById('modalBackdrop');
  const modalBox = document.getElementById('modalBox');
  function closeModal() { backdrop.classList.remove('active'); modalBox.innerHTML = ''; }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });

  function openTaskModal() {
    modalBox.innerHTML = `
      <h3>Nova tarefa</h3>
      <div class="field"><label>Título</label><input id="mTitle" type="text"></div>
      <div class="field"><label>Prazo</label><input id="mDate" type="date"></div>
      <div class="modal-actions"><button class="btn-ghost" id="mCancel">Cancelar</button><button class="btn-primary" id="mSave">Salvar</button></div>
    `;
    backdrop.classList.add('active');
    document.getElementById('mCancel').onclick = closeModal;
    document.getElementById('mSave').onclick = async () => {
      const title = document.getElementById('mTitle').value.trim();
      if (!title) return;
      await api('/api/tarefas', { method: 'POST', body: JSON.stringify({ title, due_date: document.getElementById('mDate').value || null }) });
      closeModal();
      loadView(document.querySelector('.nav-item.active')?.dataset.view || 'agenda');
    };
  }

  async function openProcessModal() {
    const clientes = (await api('/api/clientes')).clientes;
    modalBox.innerHTML = `
      <h3>Novo processo</h3>
      <div class="field"><label>Número CNJ</label><input id="mCnj" type="text" placeholder="0000000-00.0000.0.00.0000"></div>
      <div class="field"><label>Cliente</label><select id="mClient">${clientes.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}</select></div>
      <div class="field"><label>Parte contrária</label><input id="mOpp" type="text"></div>
      <div class="field"><label>Área</label><input id="mArea" type="text"></div>
      <div class="field"><label>Próximo prazo</label><input id="mDeadline" type="date"></div>
      <div class="modal-actions"><button class="btn-ghost" id="mCancel">Cancelar</button><button class="btn-primary" id="mSave">Salvar</button></div>
    `;
    backdrop.classList.add('active');
    document.getElementById('mCancel').onclick = closeModal;
    document.getElementById('mSave').onclick = async () => {
      const cnj_number = document.getElementById('mCnj').value.trim();
      const client_id = Number(document.getElementById('mClient').value);
      if (!cnj_number || !client_id) return;
      await api('/api/processos', {
        method: 'POST', body: JSON.stringify({
          cnj_number, client_id,
          opposing_party: document.getElementById('mOpp').value,
          area: document.getElementById('mArea').value,
          next_deadline: document.getElementById('mDeadline').value || null,
        })
      });
      closeModal();
      loadView('processos');
    };
  }

  function openClientModal() {
    modalBox.innerHTML = `
      <h3>Novo cliente</h3>
      <div class="field"><label>Nome</label><input id="mName" type="text"></div>
      <div class="field"><label>Tipo</label><select id="mType"><option value="PF">Pessoa física</option><option value="PJ">Pessoa jurídica</option></select></div>
      <div class="field"><label>E-mail (opcional)</label><input id="mEmail" type="email"></div>
      <div class="field"><label>Telefone / WhatsApp (opcional)</label><input id="mPhone" type="text"></div>
      <div class="modal-actions"><button class="btn-ghost" id="mCancel">Cancelar</button><button class="btn-primary" id="mSave">Salvar</button></div>
    `;
    backdrop.classList.add('active');
    document.getElementById('mCancel').onclick = closeModal;
    document.getElementById('mSave').onclick = async () => {
      const name = document.getElementById('mName').value.trim();
      if (!name) return;
      await api('/api/clientes', {
        method: 'POST', body: JSON.stringify({
          name, type: document.getElementById('mType').value,
          email: document.getElementById('mEmail').value.trim(),
          phone: document.getElementById('mPhone').value.trim(),
        })
      });
      closeModal();
      loadView('clientes');
    };
  }

  function openUserModal() {
    modalBox.innerHTML = `
      <h3>Novo usuário</h3>
      <div class="field"><label>Nome</label><input id="mName" type="text"></div>
      <div class="field"><label>E-mail</label><input id="mEmail" type="email"></div>
      <div class="field"><label>Senha provisória</label><input id="mPass" type="text" placeholder="mínimo 8 caracteres"></div>
      <div class="field"><label>Papel</label><select id="mRole">
        <option value="advogado">Advogado(a) — vê só os próprios processos</option>
        <option value="estagiario">Estagiário(a) — acesso restrito, sem financeiro</option>
        <option value="socio">Sócio(a) — acesso total, inclusive financeiro</option>
      </select></div>
      <p style="font-size:11.5px;color:var(--gray-600);margin-bottom:6px;">A pessoa deve trocar essa senha no primeiro acesso, em "Trocar senha".</p>
      <div class="modal-actions"><button class="btn-ghost" id="mCancel">Cancelar</button><button class="btn-primary" id="mSave">Salvar</button></div>
      <div id="mErr" style="color:var(--red);font-size:12.5px;margin-top:8px;"></div>
    `;
    backdrop.classList.add('active');
    document.getElementById('mCancel').onclick = closeModal;
    document.getElementById('mSave').onclick = async () => {
      const name = document.getElementById('mName').value.trim();
      const email = document.getElementById('mEmail').value.trim();
      const password = document.getElementById('mPass').value;
      const role = document.getElementById('mRole').value;
      if (!name || !email || password.length < 8) {
        document.getElementById('mErr').textContent = 'Preencha nome, e-mail e uma senha com pelo menos 8 caracteres.';
        return;
      }
      try {
        await api('/api/usuarios', { method: 'POST', body: JSON.stringify({ name, email, password, role }) });
        closeModal();
        loadUsuarios();
      } catch (e) {
        document.getElementById('mErr').textContent = e.message === 'email_ja_cadastrado' ? 'Este e-mail já está cadastrado.' : 'Não foi possível salvar.';
      }
    };
  }

  function openChangePasswordModal() {
    modalBox.innerHTML = `
      <h3>Trocar senha</h3>
      <div class="field"><label>Senha atual</label><input id="mCur" type="password"></div>
      <div class="field"><label>Nova senha</label><input id="mNew" type="password" placeholder="mínimo 8 caracteres"></div>
      <div class="modal-actions"><button class="btn-ghost" id="mCancel">Cancelar</button><button class="btn-primary" id="mSave">Salvar</button></div>
      <div id="mErr" style="color:var(--red);font-size:12.5px;margin-top:8px;"></div>
    `;
    backdrop.classList.add('active');
    document.getElementById('mCancel').onclick = closeModal;
    document.getElementById('mSave').onclick = async () => {
      const currentPassword = document.getElementById('mCur').value;
      const newPassword = document.getElementById('mNew').value;
      try {
        await api('/api/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
        closeModal();
        alert('Senha alterada com sucesso.');
      } catch (e) {
        document.getElementById('mErr').textContent = e.message === 'senha_atual_incorreta' ? 'Senha atual incorreta.' : 'Não foi possível trocar a senha (mínimo 8 caracteres).';
      }
    };
  }

  // ---------- Integrações Google ----------
  async function loadIntegracoes() {
    const el = document.getElementById('googleStatusBody');
    el.innerHTML = 'Carregando...';
    const s = await api('/api/google/status');
    if (!s.configured) {
      el.innerHTML = `<p style="color:var(--gray-600);font-size:13px;">Integração ainda não configurada pelo administrador do sistema (faltam as credenciais do Google no servidor).</p>`;
      return;
    }
    if (s.connected) {
      el.innerHTML = `
        <p style="font-size:13px;margin-bottom:12px;">Conectado como <b>${s.email}</b>.</p>
        <button class="btn-ghost" id="btnGoogleDisconnect">Desconectar</button>
      `;
      document.getElementById('btnGoogleDisconnect').addEventListener('click', async () => {
        await api('/api/google/disconnect', { method: 'POST' });
        loadIntegracoes();
      });
    } else {
      el.innerHTML = `
        <p style="font-size:13px;margin-bottom:12px;">Conecte sua conta Google para enviar e-mails e anexar documentos do Drive.</p>
        <a class="btn-primary" style="display:inline-block;text-decoration:none;" href="/auth/google/connect">Conectar Google</a>
      `;
    }
  }

  function showGoogleQueryBanner() {
    const params = new URLSearchParams(window.location.search);
    const content = document.querySelector('.content');
    if (params.get('google_conectado')) {
      const b = document.createElement('div');
      b.className = 'banner ok';
      b.textContent = 'Conta Google conectada com sucesso.';
      content.prepend(b);
      setTimeout(() => b.remove(), 5000);
    }
    if (params.get('google_erro')) {
      const b = document.createElement('div');
      b.className = 'banner err';
      b.textContent = 'Não foi possível conectar ao Google (' + params.get('google_erro') + ').';
      content.prepend(b);
      setTimeout(() => b.remove(), 6000);
    }
    if (params.get('google_conectado') || params.get('google_erro')) {
      window.history.replaceState({}, '', '/app');
    }
  }

  // ---------- Detalhe de Cliente ----------
  let currentClienteId = null;

  async function openClienteDetalhe(id) {
    currentClienteId = id;
    showDetail('view-cliente-detalhe');
    document.getElementById('pageTitle').textContent = 'Cliente';
    const d = await api('/api/clientes/' + id);
    document.getElementById('clienteDetNome').textContent = d.cliente.name;
    document.getElementById('clienteDetSub').textContent = (d.cliente.type === 'PJ' ? 'Pessoa jurídica' : 'Pessoa física') + ' · cliente desde ' + (d.cliente.since || '—') + (d.cliente.archived_at ? ' · ARQUIVADO' : '');
    const btnArquivar = document.getElementById('btnArquivarCliente');
    if (d.cliente.archived_at) {
      btnArquivar.textContent = 'Restaurar cliente';
      btnArquivar.onclick = async () => {
        await api('/api/clientes/' + id + '/restaurar', { method: 'PATCH' });
        openClienteDetalhe(id);
      };
    } else {
      btnArquivar.textContent = 'Arquivar cliente';
      btnArquivar.onclick = async () => {
        if (!confirm('Arquivar este cliente? Ele deixará de aparecer na lista de clientes ativos, mas todos os dados são preservados e podem ser restaurados depois.')) return;
        await api('/api/clientes/' + id + '/arquivar', { method: 'PATCH' });
        showView('clientes');
      };
    }
    document.getElementById('clienteDetEmail').value = d.cliente.email || '';
    document.getElementById('clienteDetPhone').value = d.cliente.phone || '';
    document.getElementById('clienteDetCpfCnpj').value = d.cliente.cpf_cnpj || '';
    document.getElementById('clienteDetRg').value = d.cliente.rg || '';
    document.getElementById('clienteDetEndereco').value = d.cliente.endereco || '';
    document.getElementById('clienteDetEstadoCivil').value = d.cliente.estado_civil || '';
    document.getElementById('clienteDetProfissao').value = d.cliente.profissao || '';
    const isPJ = d.cliente.type === 'PJ';
    document.getElementById('clienteDetCpfLabel').textContent = isPJ ? 'CNPJ' : 'CPF';
    document.getElementById('clienteDetRgField').style.display = isPJ ? 'none' : '';
    document.getElementById('clienteDetEstadoCivilField').style.display = isPJ ? 'none' : '';
    document.getElementById('clienteDetProfissaoField').style.display = isPJ ? 'none' : '';
    document.getElementById('clienteDetProcessos').innerHTML = d.processos.map(p => `
      <div class="agenda-item"><div class="agenda-text"><b class="mono">${p.cnj_number}</b><span>${p.phase || '—'} · ${fmtDate(p.next_deadline)} · ${p.responsible_name}</span></div></div>
    `).join('') || '<p style="color:var(--gray-600);font-size:13px;">Nenhum processo vinculado.</p>';
    renderArquivos('clienteDetArquivos', d.arquivos);
    document.getElementById('clienteDetEmails').innerHTML = '<p style="color:var(--gray-600);font-size:13px;">Clique em "Buscar e-mails" para sincronizar com o Gmail.</p>';
  }

  function renderArquivos(elId, arquivos) {
    document.getElementById(elId).innerHTML = arquivos.map(f => `
      <div class="file-item">
        <span>📄 ${f.name}</span>
        <span>
          ${f.mime_type === 'application/vnd.google-apps.document' ? `<a href="/api/drive/files/${f.id}/pdf">baixar PDF</a> · ` : ''}
          <a href="${f.link}" target="_blank" rel="noopener">abrir</a>
        </span>
      </div>
    `).join('') || '<p style="color:var(--gray-600);font-size:13px;">Nenhum documento anexado.</p>';
  }

  document.getElementById('btnVoltarCliente').addEventListener('click', () => showView('clientes'));

  document.getElementById('btnExcluirCliente').addEventListener('click', async () => {
    if (!confirm('Excluir este cliente PERMANENTEMENTE? Essa ação não pode ser desfeita. Só é possível se não houver processos nem faturas vinculados a ele.')) return;
    try {
      await api('/api/clientes/' + currentClienteId, { method: 'DELETE' });
      alert('Cliente excluído.');
      showView('clientes');
    } catch (err) {
      if (err.message === 'cliente_possui_vinculos') {
        alert('Não é possível excluir: este cliente possui processos e/ou faturas vinculados. Arquive o cliente em vez de excluir, ou remova esses vínculos primeiro.');
      } else if (err.message === 'sem_permissao') {
        alert('Apenas o sócio pode excluir clientes permanentemente.');
      } else {
        alert('Não foi possível excluir o cliente.');
      }
    }
  });

  document.getElementById('btnSalvarContato').addEventListener('click', async () => {
    const email = document.getElementById('clienteDetEmail').value.trim();
    const phone = document.getElementById('clienteDetPhone').value.trim();
    const cpf_cnpj = document.getElementById('clienteDetCpfCnpj').value.trim();
    const rg = document.getElementById('clienteDetRg').value.trim();
    const endereco = document.getElementById('clienteDetEndereco').value.trim();
    const estado_civil = document.getElementById('clienteDetEstadoCivil').value.trim();
    const profissao = document.getElementById('clienteDetProfissao').value.trim();
    await api('/api/clientes/' + currentClienteId, {
      method: 'PATCH',
      body: JSON.stringify({ email, phone, cpf_cnpj, rg, endereco, estado_civil, profissao }),
    });
    alert('Contato salvo.');
  });

  // ---------- Geração de documentos (Procuração / Contrato) ----------
  function openGerarDocumentoModal(tipo) {
    const titulo = tipo === 'contrato' ? 'Gerar Contrato de Prestação de Serviços' : 'Gerar Procuração';
    modalBox.innerHTML = `
      <h3>${titulo}</h3>
      <div class="field"><label>Objeto${tipo === 'contrato' ? ' do contrato' : ' da procuração'}</label>
        <textarea id="mObjeto" rows="3" style="width:100%;border:1px solid var(--gray-200);border-radius:8px;padding:9px 12px;font-family:inherit;font-size:13px;" placeholder="${tipo === 'contrato' ? 'Ex.: patrocínio da ação de cobrança nº...' : 'Ex.: representação judicial e extrajudicial em geral'}"></textarea></div>
      ${tipo === 'contrato' ? `
      <div class="field"><label>Valor dos honorários</label><input id="mValor" type="text" placeholder="Ex.: R$ 5.000,00"></div>
      <div class="field"><label>Forma de pagamento</label><input id="mForma" type="text" placeholder="Ex.: à vista, em 3 parcelas..."></div>
      ` : ''}
      <p style="font-size:11.5px;color:var(--gray-600);margin-bottom:6px;">O documento será gerado a partir de um modelo padrão e salvo no Google Drive do escritório.</p>
      <div class="modal-actions"><button class="btn-ghost" id="mCancel">Cancelar</button><button class="btn-primary" id="mSave">Gerar</button></div>
      <div id="mErr" style="color:var(--red);font-size:12.5px;margin-top:8px;"></div>
    `;
    backdrop.classList.add('active');
    document.getElementById('mCancel').onclick = closeModal;
    document.getElementById('mSave').onclick = async () => {
      const btn = document.getElementById('mSave');
      btn.disabled = true;
      btn.textContent = 'Gerando...';
      try {
        const result = await api('/api/google/documentos/gerar', {
          method: 'POST',
          body: JSON.stringify({
            client_id: currentClienteId,
            tipo,
            objeto: document.getElementById('mObjeto').value.trim(),
            valor_honorarios: document.getElementById('mValor') ? document.getElementById('mValor').value.trim() : '',
            forma_pagamento: document.getElementById('mForma') ? document.getElementById('mForma').value.trim() : '',
          }),
        });
        closeModal();
        openClienteDetalhe(currentClienteId);
        if (result && result.pdfUrl) {
          const a = document.createElement('a');
          a.href = result.pdfUrl;
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          a.remove();
        }
      } catch (err) {
        const msg = err.message === 'google_nao_conectado'
          ? 'Conecte sua conta Google em "Integrações" primeiro.'
          : 'Não foi possível gerar o documento. Tente novamente.';
        document.getElementById('mErr').textContent = msg;
        btn.disabled = false;
        btn.textContent = 'Gerar';
      }
    };
  }

  document.getElementById('btnGerarProcuracao').addEventListener('click', () => openGerarDocumentoModal('procuracao'));
  document.getElementById('btnGerarContrato').addEventListener('click', () => openGerarDocumentoModal('contrato'));

  document.getElementById('btnBuscarEmails').addEventListener('click', async () => {
    const box = document.getElementById('clienteDetEmails');
    box.innerHTML = 'Buscando...';
    try {
      const d = await api('/api/gmail/log?client_id=' + currentClienteId);
      if (d.aviso === 'cliente_sem_email') {
        box.innerHTML = '<p style="color:var(--gray-600);font-size:13px;">Cadastre o e-mail do cliente para buscar mensagens.</p>';
        return;
      }
      box.innerHTML = d.emails.map(e => `
        <div class="email-item"><b>${e.subject}</b><span>${e.from} → ${e.to} · ${e.date}</span><div>${e.snippet}</div></div>
      `).join('') || '<p style="color:var(--gray-600);font-size:13px;">Nenhum e-mail encontrado.</p>';
    } catch (err) {
      box.innerHTML = err.message === 'google_nao_conectado'
        ? '<p style="color:var(--red);font-size:13px;">Conecte sua conta Google em "Integrações" primeiro.</p>'
        : '<p style="color:var(--red);font-size:13px;">Falha ao buscar e-mails.</p>';
    }
  });

  document.getElementById('btnEnviarEmail').addEventListener('click', async () => {
    const subject = document.getElementById('emailAssunto').value.trim();
    const body = document.getElementById('emailCorpo').value.trim();
    if (!subject || !body) return;
    try {
      await api('/api/gmail/send', { method: 'POST', body: JSON.stringify({ client_id: currentClienteId, subject, body }) });
      document.getElementById('emailAssunto').value = '';
      document.getElementById('emailCorpo').value = '';
      alert('E-mail enviado.');
    } catch (err) {
      if (err.message === 'google_nao_conectado') alert('Conecte sua conta Google em "Integrações" primeiro.');
      else if (err.message === 'cliente_sem_email') alert('Cadastre o e-mail do cliente antes de enviar.');
      else alert('Não foi possível enviar o e-mail.');
    }
  });

  document.getElementById('btnAnexarClienteDrive').addEventListener('click', () => openDrivePicker({ client_id: currentClienteId }, 'clienteDetArquivos'));

  // ---------- Detalhe de Processo ----------
  let currentProcessoId = null;

  async function openProcessoDetalhe(id) {
    currentProcessoId = id;
    showDetail('view-processo-detalhe');
    document.getElementById('pageTitle').textContent = 'Processo';
    const d = await api('/api/processos/' + id);
    document.getElementById('processoDetNumero').textContent = d.processo.cnj_number;
    document.getElementById('processoDetSub').textContent = `${d.processo.client_name} · ${d.processo.phase || '—'} · responsável: ${d.processo.responsible_name}`;
    renderArquivos('processoDetArquivos', d.arquivos);
  }

  document.getElementById('btnVoltarProcesso').addEventListener('click', () => showView('processos'));
  document.getElementById('btnAnexarProcessoDrive').addEventListener('click', () => openDrivePicker({ process_id: currentProcessoId }, 'processoDetArquivos'));

  // ---------- Google Drive Picker ----------
  let gapiLoaded = false;
  function loadGapiScript() {
    return new Promise((resolve, reject) => {
      if (gapiLoaded) return resolve();
      const script = document.createElement('script');
      script.src = 'https://apis.google.com/js/api.js';
      script.onload = () => {
        gapi.load('picker', () => { gapiLoaded = true; resolve(); });
      };
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  async function openDrivePicker(target, refreshElId) {
    let tokenInfo;
    try {
      tokenInfo = await api('/api/google/picker-token');
    } catch (err) {
      alert('Conecte sua conta Google em "Integrações" antes de anexar arquivos do Drive.');
      return;
    }
    if (!tokenInfo.apiKey) {
      alert('A chave de API do Google Picker ainda não foi configurada pelo administrador (GOOGLE_PICKER_API_KEY).');
      return;
    }
    try {
      await loadGapiScript();
    } catch {
      alert('Não foi possível carregar o seletor de arquivos do Google.');
      return;
    }
    const view = new google.picker.DocsView().setIncludeFolders(true);
    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(tokenInfo.accessToken)
      .setDeveloperKey(tokenInfo.apiKey)
      .setCallback(async (data) => {
        if (data.action !== google.picker.Action.PICKED) return;
        for (const doc of data.docs) {
          await api('/api/drive/attach', {
            method: 'POST',
            body: JSON.stringify({
              ...target,
              google_file_id: doc.id,
              name: doc.name,
              mime_type: doc.mimeType,
              link: doc.url,
            }),
          });
        }
        if (target.client_id) openClienteDetalhe(target.client_id);
        else if (target.process_id) openProcessoDetalhe(target.process_id);
      })
      .build();
    picker.setVisible(true);
  }

  // ---------- Init ----------
  async function init() {
    try {
      const me = await api('/api/me');
      ME = me;
      document.getElementById('avatarInitials').textContent = initials(me.user.name);
      document.getElementById('whoName').textContent = me.user.name;
      document.getElementById('whoRole').textContent = ROLE_LABEL[me.user.role] || me.user.role;
      document.getElementById('greeting').textContent = `Olá, ${me.user.name.split(' ')[0]} 👋`;

      document.querySelectorAll('.nav-item').forEach(item => {
        if (!me.modules.includes(item.dataset.mod)) item.remove();
      });
      document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => showView(item.dataset.view));
      });

      document.getElementById('logoutBtn').addEventListener('click', async () => {
        await api('/api/logout', { method: 'POST' });
        window.location.href = '/';
      });

      document.getElementById('btnNovaTarefa').addEventListener('click', openTaskModal);
      document.getElementById('btnNovoProcesso').addEventListener('click', openProcessModal);
      document.getElementById('btnNovoCliente').addEventListener('click', openClientModal);
      document.getElementById('btnChangePassword').addEventListener('click', openChangePasswordModal);

      document.getElementById('btnVerArquivados').addEventListener('click', () => {
        showingArquivados = !showingArquivados;
        document.getElementById('btnVerArquivados').textContent = showingArquivados ? 'Ver ativos' : 'Ver arquivados';
        loadClientes();
      });

      const btnExcluirCliente = document.getElementById('btnExcluirCliente');
      if (btnExcluirCliente) btnExcluirCliente.style.display = me.user.role === 'socio' ? '' : 'none';
      const btnArquivarCliente = document.getElementById('btnArquivarCliente');
      if (btnArquivarCliente) btnArquivarCliente.style.display = me.user.role === 'estagiario' ? 'none' : '';
      const btnNovoUsuario = document.getElementById('btnNovoUsuario');
      if (btnNovoUsuario) btnNovoUsuario.addEventListener('click', openUserModal);
      document.getElementById('btnAddTimesheet').addEventListener('click', async () => {
        const description = document.getElementById('tsDesc').value.trim();
        const minutes = Number(document.getElementById('tsMinutes').value);
        if (!minutes) return;
        await api('/api/timesheet', { method: 'POST', body: JSON.stringify({ description, minutes }) });
        document.getElementById('tsDesc').value = '';
        document.getElementById('tsMinutes').value = '';
        loadTimesheet();
      });

      showGoogleQueryBanner();
      const firstMod = me.modules[0] || 'dashboard';
      showView(firstMod);
    } catch (e) {
      console.error(e);
    }
  }

  init();
})();
