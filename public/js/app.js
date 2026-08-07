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
    aberta: ['blue', 'Aberta'],
    paga: ['green', 'Paga'],
    atrasada: ['red', 'Atrasada'],
    ativo: ['blue', 'Ativo'],
    quitado: ['green', 'Quitado'],
    cancelado: ['gray', 'Cancelado'],
  };
  const FEE_TYPE_LABEL = { fixo: 'Fixo único', parcelado: 'Parcelado', mensal: 'Mensal', exito: 'Êxito' };
  const MONTH_NAMES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  function fmtMesAno(mes) {
    // mes no formato 'YYYY-MM' (vindo de strftime do SQLite)
    const [y, m] = String(mes || '').split('-');
    const idx = Number(m) - 1;
    return MONTH_NAMES[idx] ? `${MONTH_NAMES[idx]}/${y}` : mes;
  }

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
  function escapeAttr(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }
  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const AGENDA_TYPE_LABEL = { prazo: 'Prazo', audiencia: 'Audiência', tarefa: 'Tarefa', reuniao: 'Reunião', outro: 'Outro' };
  const AGENDA_PRIORITY_LABEL = { baixa: 'Baixa', media: 'Média', alta: 'Alta', urgente: 'Urgente' };

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
    if (d.faturamentoMes !== null) {
      cards.push({ v: fmtMoney(d.faturamentoMes.recebido), l: 'Recebido (mês)' });
      cards.push({ v: fmtMoney(d.faturamentoMes.aReceber), l: 'A receber (mês)' });
    }
    document.getElementById('kpiGrid').innerHTML = cards.map(c => `
      <div class="kpi-card"><div class="kpi-value">${c.v}</div><div class="kpi-label">${c.l}</div></div>
    `).join('');
    document.getElementById('dashProcessTable').innerHTML = d.recentProcesses.map(p => `
      <tr><td class="mono">${p.cnj_number}</td><td>${p.client_name}</td><td>${p.phase || '—'}</td><td>${fmtDate(p.next_deadline)}</td><td>${tag(p.status)}</td></tr>
    `).join('') || '<tr><td colspan="5">Nenhum processo.</td></tr>';

    const ag = await api('/api/agenda');
    const pending = ag.agenda.filter(x => x.type === 'tarefa' && x.status !== 'concluido').slice(0, 6);
    document.getElementById('dashTasks').innerHTML = pending.map(x => `
      <div class="checklist-item"><input type="checkbox" data-id="${x.id}" class="taskToggle"><label>${escapeHtml(x.title)}</label><span class="prazo">${fmtDate(x.event_date)}</span></div>
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

  // ---------- Agenda & Tarefas: quadro Kanban ----------
  let AGENDA_CARDS = [];
  let draggedCardId = null;
  let justDraggedCard = false;

  async function loadAgenda() {
    const d = await api('/api/agenda');
    AGENDA_CARDS = d.agenda;
    const cols = { a_fazer: [], em_andamento: [], concluido: [] };
    AGENDA_CARDS.forEach(c => { (cols[c.status] || cols.a_fazer).push(c); });
    renderKanbanColumn('colAFazer', 'countAFazer', cols.a_fazer);
    renderKanbanColumn('colEmAndamento', 'countEmAndamento', cols.em_andamento);
    renderKanbanColumn('colConcluido', 'countConcluido', cols.concluido);
    bindKanbanDnD();
    bindKanbanActions();
  }

  function renderKanbanColumn(elId, countId, cards) {
    document.getElementById(countId).textContent = cards.length;
    document.getElementById(elId).innerHTML = cards.map(c => `
      <div class="kcard" draggable="true" data-id="${c.id}">
        <div class="kcard-top">
          <span class="kcard-type ${c.type}">${AGENDA_TYPE_LABEL[c.type] || c.type}</span>
          <span class="kcard-prio ${c.priority}" title="Prioridade: ${AGENDA_PRIORITY_LABEL[c.priority] || c.priority}"></span>
        </div>
        <div class="kcard-title">${escapeHtml(c.title)}</div>
        <div class="kcard-meta">
          <span>${fmtDate(c.event_date)}${c.event_time ? ' · ' + c.event_time : ''}</span>
          ${c.client_name ? `<span>· ${escapeHtml(c.client_name)}</span>` : ''}
          ${c.google_event_id ? '<span class="kcard-gcal" title="Sincronizado com o Google Agenda">📅</span>' : ''}
        </div>
        <div class="kcard-actions">
          ${c.status !== 'em_andamento' ? `<button class="kcard-btn" data-action="em_andamento" data-id="${c.id}">Em andamento</button>` : ''}
          ${c.status !== 'concluido' ? `<button class="kcard-btn kcard-btn-ok" data-action="concluido" data-id="${c.id}">Concluído</button>` : ''}
          <button class="kcard-btn" data-action="reagendar" data-id="${c.id}">Reagendar</button>
        </div>
      </div>
    `).join('') || '<p class="kanban-empty">Nenhum card.</p>';
  }

  function bindKanbanDnD() {
    document.querySelectorAll('.kcard').forEach(card => {
      card.addEventListener('dragstart', () => { draggedCardId = card.dataset.id; card.classList.add('dragging'); });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        justDraggedCard = true;
        setTimeout(() => { justDraggedCard = false; }, 50);
      });
      card.addEventListener('click', () => {
        if (justDraggedCard) return;
        const found = AGENDA_CARDS.find(c => c.id === Number(card.dataset.id));
        if (found) openCardModal(found);
      });
    });
    document.querySelectorAll('.kanban-col-body').forEach(col => {
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
      col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('drag-over');
        if (!draggedCardId) return;
        const newStatus = col.closest('.kanban-col').dataset.status;
        const id = draggedCardId;
        draggedCardId = null;
        await api(`/api/agenda/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) });
        loadAgenda();
      });
    });
  }

  // Botões de acao rapida no card: Em andamento / Concluido (PATCH status)
  // e Reagendar (abre mini-modal so com data/hora).
  function bindKanbanActions() {
    document.querySelectorAll('.kcard-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number(btn.dataset.id);
        const action = btn.dataset.action;
        const card = AGENDA_CARDS.find(c => c.id === id);
        if (!card) return;
        if (action === 'reagendar') {
          openReagendarModal(card);
          return;
        }
        btn.disabled = true;
        try {
          await api(`/api/agenda/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: action }) });
          loadAgenda();
        } catch {
          btn.disabled = false;
        }
      });
    });
  }

  function openReagendarModal(card) {
    modalBox.innerHTML = `
      <h3>Reagendar</h3>
      <p style="font-size:12.5px;color:var(--gray-600);margin-bottom:10px;">${escapeHtml(card.title)}</p>
      <div class="field"><label>Nova data</label><input id="rDate" type="date" value="${card.event_date || ''}"></div>
      <div class="field"><label>Nova hora (deixe em branco para dia inteiro)</label><input id="rTime" type="time" value="${card.event_time || ''}"></div>
      <div class="modal-actions"><button class="btn-ghost" id="mCancel">Cancelar</button><button class="btn-primary" id="mSave">Salvar</button></div>
      <div id="mErr" style="color:var(--red);font-size:12.5px;margin-top:8px;"></div>
    `;
    backdrop.classList.add('active');
    document.getElementById('mCancel').onclick = closeModal;
    document.getElementById('mSave').onclick = async () => {
      const event_date = document.getElementById('rDate').value;
      if (!event_date) {
        document.getElementById('mErr').textContent = 'Escolha uma data.';
        return;
      }
      const event_time = document.getElementById('rTime').value;
      const btn = document.getElementById('mSave');
      btn.disabled = true;
      try {
        await api('/api/agenda/' + card.id, {
          method: 'PATCH',
          body: JSON.stringify({
            title: card.title,
            detail: card.detail || '',
            type: card.type,
            priority: card.priority,
            event_date,
            event_time,
            location: card.location || '',
            client_id: card.client_id || null,
            process_id: card.process_id || null,
          }),
        });
        closeModal();
        loadAgenda();
      } catch (e) {
        document.getElementById('mErr').textContent = 'Não foi possível reagendar.';
        btn.disabled = false;
      }
    };
  }

  // Monta assunto/corpo padrao do e-mail de atualizacao para o cliente,
  // a partir dos dados do card (editavel antes de enviar).
  function buildEmailTemplate(card) {
    const typeLabel = (AGENDA_TYPE_LABEL[card.type] || card.type).toLowerCase();
    const statusLabel = card.status === 'concluido' ? 'concluído(a)' : (card.status === 'em_andamento' ? 'em andamento' : 'pendente');
    const dataTxt = card.event_date ? fmtDate(card.event_date) + (card.event_time ? ' às ' + card.event_time : '') : '';
    const subject = `Atualização — ${card.title}`;
    let body = `Prezado(a) ${card.client_name || 'cliente'},\n\n`;
    body += `Informamos uma atualização sobre ${typeLabel} "${card.title}": está atualmente ${statusLabel}.\n\n`;
    if (dataTxt) body += `Data: ${dataTxt}${card.location ? ' — ' + card.location : ''}\n\n`;
    if (card.detail) body += `Observações: ${card.detail}\n\n`;
    body += `Qualquer dúvida, estamos à disposição.\n\nAtenciosamente,\nSerafim Advogados`;
    return { subject, body };
  }

  async function openCardModal(card) {
    const isEdit = Boolean(card);
    const [clientes, processos] = await Promise.all([
      api('/api/clientes').then(d => d.clientes).catch(() => []),
      api('/api/processos').then(d => d.processos).catch(() => []),
    ]);
    modalBox.innerHTML = `
      <h3>${isEdit ? 'Editar card' : 'Novo card'}</h3>
      <div class="field"><label>Título</label><input id="mTitle" type="text" value="${isEdit ? escapeAttr(card.title) : ''}"></div>
      <div class="field"><label>Tipo</label><select id="mType">
        ${Object.entries(AGENDA_TYPE_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
      </select></div>
      <div class="field"><label>Prioridade</label><select id="mPriority">
        ${Object.entries(AGENDA_PRIORITY_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
      </select></div>
      <div class="field"><label>Data</label><input id="mDate" type="date" value="${isEdit ? card.event_date : ''}"></div>
      <div class="field"><label>Hora (deixe em branco para card de dia inteiro)</label><input id="mTime" type="time" value="${isEdit ? (card.event_time || '') : ''}"></div>
      <div class="field"><label>Local (audiências/reuniões)</label><input id="mLocation" type="text" value="${isEdit ? escapeAttr(card.location || '') : ''}" placeholder="Fórum X, sala Y / link da videochamada"></div>
      <div class="field"><label>Cliente (opcional)</label><select id="mClient"><option value="">—</option>${clientes.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Processo (opcional)</label><select id="mProcess"><option value="">—</option>${processos.map(p => `<option value="${p.id}">${escapeHtml(p.cnj_number)} — ${escapeHtml(p.client_name)}</option>`).join('')}</select></div>
      <div class="field"><label>Descrição</label><textarea id="mDetail" rows="3" style="width:100%;border:1px solid var(--gray-200);border-radius:8px;padding:9px 12px;font-family:inherit;font-size:13px;">${isEdit ? escapeHtml(card.detail || '') : ''}</textarea></div>
      <p style="font-size:11.5px;color:var(--gray-600);margin-bottom:6px;">Se a conta Google do escritório estiver conectada, este card também é criado/atualizado no Google Agenda, com lembrete por e-mail 1 dia antes.</p>
      ${isEdit && card.client_id ? `
      <div class="field">
        <button class="btn-ghost" id="mOpenEmail" type="button">✉️ Enviar atualização por e-mail ao cliente</button>
      </div>
      <div id="emailBox" style="display:none;border-top:1px solid var(--gray-200);margin-top:4px;padding-top:10px;">
        <div class="field"><label>Assunto</label><input id="rEmailSubject" type="text"></div>
        <div class="field"><label>Mensagem</label><textarea id="rEmailBody" rows="6" style="width:100%;border:1px solid var(--gray-200);border-radius:8px;padding:9px 12px;font-family:inherit;font-size:13px;"></textarea></div>
        <div class="modal-actions"><button class="btn-ghost" id="mCancelEmail" type="button">Fechar</button><button class="btn-primary" id="mSendEmail" type="button">Enviar</button></div>
        <div id="mEmailMsg" style="font-size:12.5px;margin-top:6px;"></div>
      </div>
      ` : ''}
      <div class="modal-actions">
        ${isEdit ? '<button class="btn-ghost" id="mDelete" style="color:#c0392b;border-color:#c0392b;margin-right:auto;">Excluir</button>' : ''}
        <button class="btn-ghost" id="mCancel">Cancelar</button><button class="btn-primary" id="mSave">Salvar</button>
      </div>
      <div id="mErr" style="color:var(--red);font-size:12.5px;margin-top:8px;"></div>
    `;
    backdrop.classList.add('active');
    if (isEdit) {
      document.getElementById('mType').value = card.type;
      document.getElementById('mPriority').value = card.priority;
      if (card.client_id) document.getElementById('mClient').value = String(card.client_id);
      if (card.process_id) document.getElementById('mProcess').value = String(card.process_id);
      document.getElementById('mDelete').onclick = async () => {
        if (!confirm('Excluir este card? Se estiver sincronizado, o evento também será removido do Google Agenda.')) return;
        await api('/api/agenda/' + card.id, { method: 'DELETE' });
        closeModal();
        loadAgenda();
      };
      if (card.client_id) {
        document.getElementById('mOpenEmail').onclick = () => {
          const tpl = buildEmailTemplate(card);
          document.getElementById('rEmailSubject').value = tpl.subject;
          document.getElementById('rEmailBody').value = tpl.body;
          document.getElementById('emailBox').style.display = 'block';
          document.getElementById('mOpenEmail').style.display = 'none';
        };
        document.getElementById('mCancelEmail').onclick = () => {
          document.getElementById('emailBox').style.display = 'none';
          document.getElementById('mOpenEmail').style.display = '';
        };
        document.getElementById('mSendEmail').onclick = async () => {
          const subject = document.getElementById('rEmailSubject').value.trim();
          const body = document.getElementById('rEmailBody').value.trim();
          const msgEl = document.getElementById('mEmailMsg');
          if (!subject || !body) {
            msgEl.style.color = 'var(--red)';
            msgEl.textContent = 'Preencha assunto e mensagem.';
            return;
          }
          const sendBtn = document.getElementById('mSendEmail');
          sendBtn.disabled = true;
          try {
            await api('/api/gmail/send', { method: 'POST', body: JSON.stringify({ client_id: card.client_id, subject, body }) });
            msgEl.style.color = 'var(--green)';
            msgEl.textContent = 'E-mail enviado.';
          } catch (err) {
            msgEl.style.color = 'var(--red)';
            msgEl.textContent = err.message === 'google_nao_conectado'
              ? 'Conecte sua conta Google em "Integrações" primeiro.'
              : (err.message === 'cliente_sem_email' ? 'Cadastre o e-mail do cliente antes de enviar.' : 'Não foi possível enviar o e-mail.');
          }
          sendBtn.disabled = false;
        };
      }
    } else {
      document.getElementById('mType').value = 'tarefa';
      document.getElementById('mPriority').value = 'media';
    }
    document.getElementById('mCancel').onclick = closeModal;
    document.getElementById('mSave').onclick = async () => {
      const title = document.getElementById('mTitle').value.trim();
      const event_date = document.getElementById('mDate').value;
      if (!title || !event_date) {
        document.getElementById('mErr').textContent = 'Preencha ao menos o título e a data.';
        return;
      }
      const payload = {
        title,
        detail: document.getElementById('mDetail').value.trim(),
        type: document.getElementById('mType').value,
        priority: document.getElementById('mPriority').value,
        event_date,
        event_time: document.getElementById('mTime').value,
        location: document.getElementById('mLocation').value.trim(),
        client_id: document.getElementById('mClient').value || null,
        process_id: document.getElementById('mProcess').value || null,
      };
      const btn = document.getElementById('mSave');
      btn.disabled = true;
      try {
        if (isEdit) await api('/api/agenda/' + card.id, { method: 'PATCH', body: JSON.stringify(payload) });
        else await api('/api/agenda', { method: 'POST', body: JSON.stringify(payload) });
        closeModal();
        loadAgenda();
      } catch (e) {
        document.getElementById('mErr').textContent = 'Não foi possível salvar o card.';
        btn.disabled = false;
      }
    };
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
      const [d, dc] = await Promise.all([api('/api/financeiro'), api('/api/contracts')]);
      el.innerHTML = `
        <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:20px;">
          <div class="kpi-card"><div class="kpi-value">${fmtMoney(d.recebido)}</div><div class="kpi-label">Recebido (mês)</div></div>
          <div class="kpi-card"><div class="kpi-value">${fmtMoney(d.aReceber)}</div><div class="kpi-label">A receber (mês)</div></div>
          <div class="kpi-card"><div class="kpi-value">${fmtMoney(d.atrasado)}</div><div class="kpi-label">Em atraso</div></div>
        </div>
        <h3 style="margin:0 0 10px;font-size:15px;">Recebimentos por mês</h3>
        <div class="card" style="margin-bottom:22px;"><table><thead><tr>
          <th>Mês</th><th>Recebido</th><th>A receber</th><th>Em atraso</th>
        </tr></thead>
        <tbody>${d.porMes && d.porMes.length ? d.porMes.map(m => `
          <tr>
            <td>${fmtMesAno(m.mes)}</td>
            <td>${fmtMoney(m.recebido)}</td>
            <td>${fmtMoney(m.aReceber)}</td>
            <td>${m.atrasado > 0 ? `<span style="color:var(--red);">${fmtMoney(m.atrasado)}</span>` : fmtMoney(m.atrasado)}</td>
          </tr>
        `).join('') : '<tr><td colspan="4" style="color:var(--gray-600);">Nenhum lançamento com vencimento definido.</td></tr>'}</tbody></table></div>
        <h3 style="margin:0 0 10px;font-size:15px;">Contratos</h3>
        <div class="card" style="margin-bottom:22px;"><table><thead><tr>
          <th>Cliente</th><th>Título</th><th>Tipo</th><th>Valor total</th><th>Parcelas pagas</th><th>Status</th><th></th>
        </tr></thead>
        <tbody id="contractsTable">${dc.contracts.length ? dc.contracts.map(c => `
          <tr>
            <td>${escapeHtml(c.client_name)}</td>
            <td>${escapeHtml(c.title)}</td>
            <td>${FEE_TYPE_LABEL[c.fee_type] || c.fee_type}</td>
            <td>${fmtMoney(c.total_amount_cents)}</td>
            <td>${c.paid_count}/${c.installments_count} (${fmtMoney(c.paid_cents)})</td>
            <td>${tag(c.status)}</td>
            <td><button class="btn-ghost delContractBtn" data-id="${c.id}" style="font-size:11px;padding:5px 10px;">Excluir</button></td>
          </tr>
        `).join('') : '<tr><td colspan="7" style="color:var(--gray-600);">Nenhum contrato cadastrado.</td></tr>'}</tbody></table></div>
        <h3 style="margin:0 0 10px;font-size:15px;">Faturas / Parcelas</h3>
        <div class="card"><table><thead><tr><th>Cliente</th><th>Contrato</th><th>Valor</th><th>Vencimento</th><th>Status</th><th></th></tr></thead>
        <tbody id="invoicesTable">${d.faturas.length ? d.faturas.map(f => `
          <tr>
            <td>${escapeHtml(f.client_name)}</td>
            <td>${f.contract_title ? escapeHtml(f.contract_title) : '<span style="color:var(--gray-600);">Avulsa</span>'}</td>
            <td>${fmtMoney(f.amount_cents)}</td>
            <td>${fmtDate(f.due_date)}</td>
            <td>${tag(f.status)}</td>
            <td><button class="btn-ghost toggleInvoiceBtn" data-id="${f.id}" data-status="${f.status}" style="font-size:11px;padding:5px 10px;">${f.status === 'paga' ? 'Desfazer' : 'Marcar paga'}</button></td>
          </tr>
        `).join('') : '<tr><td colspan="6" style="color:var(--gray-600);">Nenhuma fatura.</td></tr>'}</tbody></table></div>
      `;
      document.querySelectorAll('.toggleInvoiceBtn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const novoStatus = btn.dataset.status === 'paga' ? 'aberta' : 'paga';
          await api(`/api/invoices/${btn.dataset.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: novoStatus }) });
          loadFinanceiro();
        });
      });
      document.querySelectorAll('.delContractBtn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Excluir este contrato e todas as parcelas em aberto? Só é possível se nenhuma parcela já tiver sido paga.')) return;
          try {
            await api(`/api/contracts/${btn.dataset.id}`, { method: 'DELETE' });
            loadFinanceiro();
          } catch (e) {
            alert(e.message === 'contrato_com_parcelas_pagas' ? 'Não é possível excluir: este contrato já tem parcela(s) paga(s).' : 'Não foi possível excluir.');
          }
        });
      });
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
        await api(`/api/agenda/${cb.dataset.id}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: cb.checked ? 'concluido' : 'a_fazer' }),
        });
        loadView(document.querySelector('.nav-item.active')?.dataset.view || 'dashboard');
      });
    });
  }

  // ---------- Modais simples ----------
  const backdrop = document.getElementById('modalBackdrop');
  const modalBox = document.getElementById('modalBox');
  function closeModal() { backdrop.classList.remove('active'); modalBox.innerHTML = ''; }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });

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

  async function openContractModal() {
    const [clientes, processos] = await Promise.all([
      api('/api/clientes').then(d => d.clientes).catch(() => []),
      api('/api/processos').then(d => d.processos).catch(() => []),
    ]);
    modalBox.innerHTML = `
      <h3>Novo contrato</h3>
      <div class="field"><label>Cliente</label><select id="mClient">${clientes.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Processo (opcional)</label><select id="mProcess"><option value="">—</option>${processos.map(p => `<option value="${p.id}">${escapeHtml(p.cnj_number)} — ${escapeHtml(p.client_name)}</option>`).join('')}</select></div>
      <div class="field"><label>Título</label><input id="mTitle" type="text" placeholder="Ex.: Honorários — Ação de Cobrança"></div>
      <div class="field"><label>Tipo de honorário</label><select id="mFeeType">
        <option value="fixo">Fixo único</option>
        <option value="parcelado" selected>Parcelado</option>
        <option value="mensal">Mensal</option>
        <option value="exito">Êxito</option>
      </select></div>
      <div class="field"><label>Valor total (R$)</label><input id="mValor" type="number" min="0" step="0.01" placeholder="0,00"></div>
      <div class="field"><label>Número de parcelas</label><input id="mParcelas" type="number" min="1" step="1" value="1"></div>
      <div class="field"><label>Data da 1ª parcela</label><input id="mPrimeiraData" type="date"></div>
      <div class="field"><label>Observações (opcional)</label><textarea id="mNotes" rows="2" style="width:100%;border:1px solid var(--gray-200);border-radius:8px;padding:9px 12px;font-family:inherit;font-size:13px;"></textarea></div>
      <div class="modal-actions"><button class="btn-ghost" id="mCancel">Cancelar</button><button class="btn-primary" id="mSave">Salvar</button></div>
      <div id="mErr" style="color:var(--red);font-size:12.5px;margin-top:8px;"></div>
    `;
    backdrop.classList.add('active');
    document.getElementById('mCancel').onclick = closeModal;
    document.getElementById('mSave').onclick = async () => {
      const client_id = Number(document.getElementById('mClient').value);
      const process_id = document.getElementById('mProcess').value || null;
      const title = document.getElementById('mTitle').value.trim();
      const fee_type = document.getElementById('mFeeType').value;
      const valor = parseFloat(document.getElementById('mValor').value.replace(',', '.'));
      const installments_count = Number(document.getElementById('mParcelas').value) || 1;
      const first_due_date = document.getElementById('mPrimeiraData').value;
      const notes = document.getElementById('mNotes').value.trim();
      const errEl = document.getElementById('mErr');
      if (!client_id || !title || !valor || valor <= 0 || !first_due_date || installments_count < 1) {
        errEl.textContent = 'Preencha cliente, título, valor total (maior que zero) e a data da 1ª parcela.';
        return;
      }
      const btn = document.getElementById('mSave');
      btn.disabled = true;
      try {
        await api('/api/contracts', {
          method: 'POST',
          body: JSON.stringify({
            client_id, process_id, title, fee_type,
            total_amount_cents: Math.round(valor * 100),
            installments_count, first_due_date, notes,
          }),
        });
        closeModal();
        loadFinanceiro();
      } catch (e) {
        errEl.textContent = 'Não foi possível salvar o contrato. Confira os dados e tente novamente.';
        btn.disabled = false;
      }
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
      <div class="field"><label>Senha atual</label><input id="mCur" type="password" autocapitalize="none" autocorrect="off" spellcheck="false"></div>
      <div class="field"><label>Nova senha</label><input id="mNew" type="password" placeholder="mínimo 8 caracteres" autocapitalize="none" autocorrect="off" spellcheck="false"></div>
      <div class="modal-actions"><button class="btn-ghost" id="mCancel">Cancelar</button><button class="btn-primary" id="mSave">Salvar</button></div>
      <div id="mErr" style="color:var(--red);font-size:12.5px;margin-top:8px;"></div>
    `;
    backdrop.classList.add('active');
    document.getElementById('mCancel').onclick = closeModal;
    document.getElementById('mSave').onclick = async () => {
      const currentPassword = document.getElementById('mCur').value.trim();
      const newPassword = document.getElementById('mNew').value.trim();
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

      document.getElementById('btnNovoCard').addEventListener('click', () => openCardModal(null));
      document.getElementById('btnNovoProcesso').addEventListener('click', openProcessModal);
      document.getElementById('btnNovoCliente').addEventListener('click', openClientModal);
      document.getElementById('btnNovoContrato').addEventListener('click', openContractModal);
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
