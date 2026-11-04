function renderAgenda() {
  const events = state.events
    .filter(e => e.type === 'compromisso' || e.type === 'reuniao')
    .sort((a, b) => `${a.date} ${a.time || ''}`.localeCompare(`${b.date} ${b.time || ''}`));

  $('#agenda-list').innerHTML = events.length
    ? events.map(event => `
      <div class="agenda-event">
        <div>
          <h3>${esc(event.title)}</h3>
          <p><i class="fa-regular fa-calendar"></i> ${[date(event.date), esc(event.time || ''), esc(event.description || '')].filter(Boolean).join(' · ')}</p>
        </div>
        ${removeButton('event', event.id)}
      </div>
    `).join('')
    : '<div class="panel"><p class="muted">Nenhum agendamento criado.</p></div>';
}

function allEvents() {
  const accountEvents = state.accounts.map(account => ({
    id: `account-${account.id}`,
    title: `${account.tipo === 'pagar' ? 'Pagamento' : 'Recebimento'}: ${account.descricao}`,
    date: account.vencimento,
    type: account.tipo === 'pagar' ? 'pagamento' : 'recebimento',
    virtual: true
  }));
  return [...state.events, ...accountEvents];
}

const CALENDAR_MONTH_NAMES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

let calendarView = 'month';

function calendarControls() {
  const referenceDate = state.calendarDate;
  const monthSelect = $('#calendar-month');
  const yearSelect = $('#calendar-year');
  if (!monthSelect || !yearSelect) return;

  monthSelect.innerHTML = CALENDAR_MONTH_NAMES
    .map((name, index) => `<option value="${index}">${name}</option>`)
    .join('');

  const currentYear = referenceDate.getFullYear();
  yearSelect.innerHTML = Array.from({ length: 21 }, (_, offset) => currentYear - 10 + offset)
    .map(year => `<option value="${year}">${year}</option>`)
    .join('');

  monthSelect.value = referenceDate.getMonth();
  yearSelect.value = referenceDate.getFullYear();
}

function renderCalendarDayCell(cellDate, events) {
  const iso = toISODate(cellDate);
  const isToday = iso === todayISO();
  const dayEvents = events.filter(e => e.date === iso).slice(0, 4)
    .map(e => `<div class="calendar-event">${esc(e.title)}</div>`).join('');
  return `<div class="day ${isToday ? 'today' : ''}"><span class="day-number">${cellDate.getDate()}</span>${dayEvents}</div>`;
}

function renderUpcomingEventsList(events) {
  return events.filter(e => e.date >= todayISO()).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8)
    .map(e => `
      <div class="list-item">
        <span class="list-icon"><i class="fa-solid fa-calendar-day"></i></span>
        <div><b>${esc(e.title)}</b><small>${date(e.date)}</small></div>
      </div>
    `).join('') || '<p class="muted">Nenhum evento próximo.</p>';
}

function renderCalendarYearView(year, events) {
  const months = Array.from({ length: 12 }, (_, month) => {
    const count = events.filter(e => {
      const eventDate = new Date(`${e.date}T12:00:00`);
      return eventDate.getFullYear() === year && eventDate.getMonth() === month;
    }).length;
    const label = new Date(year, month, 1).toLocaleDateString('pt-BR', { month: 'long' });
    return `<div class="panel year-card"><h3>${label}</h3><strong>${count}</strong><small>eventos</small></div>`;
  }).join('');

  $('#calendar-grid').innerHTML = `<div class="year-grid">${months}</div>`;
  $('#calendar-events').innerHTML = '<p class="muted">Visão anual agrupada por mês.</p>';
}

function renderCalendarDayView(referenceDate, events) {
  const iso = toISODate(referenceDate);
  const label = referenceDate.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const dayEvents = events.filter(e => e.date === iso).map(e => `
    <div class="agenda-event">
      <div><h3>${esc(e.title)}</h3><p>${[esc(e.time || ''), esc(e.description || '')].filter(Boolean).join(' · ')}</p></div>
    </div>
  `).join('') || '<p class="muted">Nenhum evento neste dia.</p>';

  $('#calendar-grid').innerHTML = `<div class="day-view"><h3>${label}</h3>${dayEvents}</div>`;
  $('#calendar-events').innerHTML = '<p class="muted">Selecione outro dia usando as setas ou os controles.</p>';
}

function renderCalendarGridView(referenceDate, events) {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth();

  let rangeStart = new Date(year, month, 1);
  if (calendarView === 'week') {
    rangeStart = new Date(referenceDate);
    rangeStart.setDate(referenceDate.getDate() - referenceDate.getDay());
  }

  const daysToRender = calendarView === 'week' ? 7 : new Date(year, month + 1, 0).getDate();
  const cells = [];

  if (calendarView === 'month') {
    for (let i = 0; i < new Date(year, month, 1).getDay(); i++) {
      cells.push('<div class="day muted-day"></div>');
    }
  }

  for (let n = 0; n < daysToRender; n++) {
    const cellDate = new Date(rangeStart);
    cellDate.setDate(rangeStart.getDate() + n);
    cells.push(renderCalendarDayCell(cellDate, events));
  }
  while (cells.length % 7) cells.push('<div class="day muted-day"></div>');

  $('#calendar-grid').innerHTML = cells.join('');
  $('#calendar-events').innerHTML = renderUpcomingEventsList(events);
}

function renderCalendar() {
  const referenceDate = state.calendarDate;
  calendarControls();
  const events = allEvents();

  if (calendarView === 'year') return renderCalendarYearView(referenceDate.getFullYear(), events);
  if (calendarView === 'day') return renderCalendarDayView(referenceDate, events);
  renderCalendarGridView(referenceDate, events);
}

// No mes, o dia vai para 1 antes da troca: de 31 de janeiro o calendario pularia para marco.
function moveCalendar(direction) {
  const current = state.calendarDate;
  if (calendarView === 'day') current.setDate(current.getDate() + direction);
  else if (calendarView === 'week') current.setDate(current.getDate() + 7 * direction);
  else if (calendarView === 'year') current.setFullYear(current.getFullYear() + direction, current.getMonth(), 1);
  else current.setMonth(current.getMonth() + direction, 1);
  renderCalendar();
}

function bindCalendarControls() {
  $('#calendar-month').onchange = event => {
    state.calendarDate.setMonth(Number(event.target.value), 1);
    renderCalendar();
  };
  $('#calendar-year').onchange = event => {
    state.calendarDate.setFullYear(Number(event.target.value), state.calendarDate.getMonth(), 1);
    renderCalendar();
  };
  $('#next-month').onclick = () => moveCalendar(1);
  $('#prev-month').onclick = () => moveCalendar(-1);

  $$('[data-view]').forEach(button => {
    button.onclick = () => {
      $$('[data-view]').forEach(other => other.classList.remove('active'));
      button.classList.add('active');
      calendarView = button.dataset.view;
      renderCalendar();
    };
  });
}

document.addEventListener('DOMContentLoaded', bindCalendarControls);
