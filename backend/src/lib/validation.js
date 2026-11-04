const { HttpError } = require('./http-helpers');
const { isValidEmail } = require('./security');
const MAX_POSTGRES_INTEGER = 2147483647;
const MAX_CENTS = 999999999999;

function invalid(message) {
  return new HttpError(400, 'invalid_request', message);
}

const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);

function asText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function requiredText(value, label, maxLength) {
  const text = asText(value);
  if (!text) throw invalid(`Informe ${label}.`);
  if (text.length > maxLength) throw invalid(`Reduza ${label}: o limite é de ${maxLength} caracteres.`);
  return text;
}

function optionalText(value, label, maxLength) {
  const text = asText(value);
  if (!text) return null;
  if (text.length > maxLength) throw invalid(`Reduza ${label}: o limite é de ${maxLength} caracteres.`);
  return text;
}

function optionalEmail(value, label = 'e-mail') {
  const text = asText(value).toLowerCase();
  if (!text) return null;
  if (!isValidEmail(text)) throw invalid(`Informe um ${label} válido.`);
  return text;
}

// Centavos a partir do texto, com arredondamento comercial. String(1.005) e "1.005"; multiplicar
// o Number por 100 daria 100.4999... e o valor viraria 1.00.
function parseCents(value) {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  const match = text.match(/^(\d+)(?:[.,](\d+))?$/);
  if (!match) return null;
  const [, integerPart, fraction = ''] = match;
  if (integerPart.replace(/^0+/, '').length > 10) return Infinity;

  const digits = (fraction + '000').slice(0, 3);
  return Number(integerPart) * 100 + Number(digits.slice(0, 2)) + (Number(digits[2]) >= 5 ? 1 : 0);
}

// Devolve texto decimal ("10.50"): o NUMERIC(12,2) recebe o valor exato, sem passar por Number.
function money(value, label, { allowZero = false } = {}) {
  const cents = parseCents(value);
  const aboveMinimum = cents !== null && (allowZero ? cents >= 0 : cents > 0);
  if (!aboveMinimum) {
    throw invalid(`Informe ${label} ${allowZero ? 'igual ou maior que zero' : 'maior que zero'}.`);
  }
  if (cents > MAX_CENTS) throw invalid('O valor informado está acima do máximo permitido.');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function integer(value, label, { min = 0, fallback } = {}) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > MAX_POSTGRES_INTEGER) {
    throw invalid(`Informe ${label} com um número inteiro a partir de ${min}.`);
  }
  return number;
}

function isoDate(value, label, { required = false } = {}) {
  const text = asText(value);
  if (!text) {
    if (required) throw invalid(`Informe ${label}.`);
    return null;
  }
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const parsed = match ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])) : null;
  const isRealDate = parsed && parsed.getUTCMonth() === +match[2] - 1 && parsed.getUTCDate() === +match[3];
  if (!isRealDate || +match[1] < 1900 || +match[1] > 2200) throw invalid(`${capitalize(label)} não é uma data válida.`);
  return text;
}

function time(value, label) {
  const text = asText(value);
  if (!text) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(text)) throw invalid(`Informe ${label} no formato HH:MM.`);
  return text.slice(0, 5);
}

function stateCode(value) {
  const text = asText(value).toUpperCase();
  if (!text) return null;
  if (!/^[A-Z]{2}$/.test(text)) throw invalid('Informe o estado com a sigla de duas letras (ex.: SP).');
  return text;
}

// Campo ausente usa o padrao; valor enviado fora da lista e recusado (nao vira outro tipo em silencio).
function oneOf(value, allowed, fallback, label = 'o tipo') {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) throw invalid(`Escolha ${label} entre as opções disponíveis.`);
  return value;
}

function optionalBoolean(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw invalid(`O campo ${label} precisa ser verdadeiro ou falso.`);
  return value;
}

module.exports = {
  invalid,
  requiredText,
  optionalText,
  optionalEmail,
  money,
  integer,
  isoDate,
  time,
  stateCode,
  oneOf,
  optionalBoolean
};
