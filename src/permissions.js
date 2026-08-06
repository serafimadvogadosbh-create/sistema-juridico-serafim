// permissions.js — regras de acesso por papel
'use strict';

// Modulos visiveis na sidebar por papel
const MODULES_BY_ROLE = {
  socio: ['dashboard', 'processos', 'agenda', 'clientes', 'financeiro', 'timesheet', 'usuarios'],
  advogado: ['dashboard', 'processos', 'agenda', 'clientes', 'timesheet'],
  estagiario: ['dashboard', 'processos', 'agenda', 'timesheet'],
};

// Processos: socio ve todos; advogado e estagiario veem so os que sao responsaveis
function canSeeAllProcesses(role) {
  return role === 'socio';
}

// Financeiro: somente socio
function canAccessFinanceiro(role) {
  return role === 'socio';
}

// Edicao de processos: socio e advogado podem editar os proprios; estagiario e somente leitura
function canEditProcess(role, process, userId) {
  if (role === 'estagiario') return false;
  if (role === 'socio') return true;
  return process.responsible_id === userId;
}

// Gestao de usuarios (criar/editar contas): somente socio
function canManageUsers(role) {
  return role === 'socio';
}

module.exports = {
  MODULES_BY_ROLE,
  canSeeAllProcesses,
  canAccessFinanceiro,
  canEditProcess,
  canManageUsers,
};
