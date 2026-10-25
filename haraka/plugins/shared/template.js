/**
 * template.js - email template loading and rendering
 *
 * Reads .txt templates from /app/config/templates/,
 * rendered with Mustache.
 */

const fs = require('fs');
const path = require('path');
const Mustache = require('mustache');

const TEMPLATE_DIR = '/app/config/templates';

// template cache
const _cache = {};

/**
 * Load a template file
 * @param {string} name - template name (without .txt)
 * @returns {string} template contents
 */
function loadTemplate(name) {
  if (_cache[name]) return _cache[name];

  const filePath = path.join(TEMPLATE_DIR, `${name}.txt`);
  if (!fs.existsSync(filePath)) {
    console.error(`[template] Template not found: ${filePath}`);
    return `[Template not found: ${name}]`;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  _cache[name] = content;
  return content;
}

/**
 * Render a template
 * @param {string} name - template name
 * @param {object} vars - template variables
 * @returns {string} rendered text
 */
function render(name, vars = {}) {
  const template = loadTemplate(name);
  try {
    return Mustache.render(template, vars);
  } catch (err) {
    console.error(`[template] Render error for "${name}":`, err.message);
    return template; // fall back to the raw template
  }
}

/**
 * Reload all cached templates (development/hot reload)
 */
function clearCache() {
  for (const key of Object.keys(_cache)) {
    delete _cache[key];
  }
}

module.exports = {
  render,
  loadTemplate,
  clearCache,
};
