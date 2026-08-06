(function () {
  'use strict';

  const titles = {
    dashboard: 'Dashboard', processos: 'Processos', agenda: 'Agenda & Tarefas',
    clientes: 'Clientes', financeiro: 'Financeiro', timesheet: 'Timesheet', usuarios: 'Usuários',
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
      <tr>
        <td class="mono">${p.cnj_number}</td><td>${p.client_name}</td><td>${p.opposing_party || '—'}</td>
        <td>${p.area || '—'}</td><td>${p.phase || '—'}</td><td>${fmtDate(p.next_deadline)}</td>
        <td>${p.responsible_name}</td><td>${tag(p.status)}</td>
      </tr>
    `).join('') || '<tr><td colspan="8">Nenhum processo encontrado.</td></tr>';
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

  async function loadClientes() {
    const d = await api('/api/clientes');
    document.getElementById('clientesSub').textContent = `${d.clientes.length} cliente(s) cadastrado(s)`;
    document.getElementById('clientesTable').innerHTML = d.clientes.map(c => `
      <tr><td>${c.name}</td><td>${c.type === 'PJ' ? 'Pessoa jurídica' : 'Pessoa física'}</td><td>${c.since || '—'}</td></tr>
    `).join('') || '<tr><td colspan="3">Nenhum cliente.</td></tr>';
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
      <div class="modal-actions"><button class="btn-ghost" id="mCancel">Cancelar</button><button class="btn-primary" id="mSave">Salvar</button></div>
    `;
    backdrop.classList.add('active');
    document.getElementById('mCancel').onclick = closeModal;
    document.getElementById('mSave').onclick = async () => {
      const name = document.getElementById('mName').value.trim();
      if (!name) return;
      await api('/api/clientes', { method: 'POST', body: JSON.stringify({ name, type: document.getElementById('mType').value }) });
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

      const firstMod = me.modules[0] || 'dashboard';
      showView(firstMod);
    } catch (e) {
      console.error(e);
    }
  }

  init();
})();
