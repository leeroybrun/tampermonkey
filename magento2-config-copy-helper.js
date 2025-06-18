// ==UserScript==
// @name         Magento 2 Config Copy Helper
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Add copy buttons for Magento 2 configuration paths and values
// @author       You
// @match        */admin/system_config/*
// @match        */shopbackend/admin/system_config/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // CSS styles for the copy buttons
    var styles = `
        .config-copy-btn {
            background: #007cba;
            color: white;
            border: none;
            padding: 4px 8px;
            margin-left: 5px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
            font-family: 'Open Sans', sans-serif;
        }
        .config-copy-btn:hover {
            background: #005a87;
        }
        .config-copy-btn.cli {
            background: #28a745;
        }
        .config-copy-btn.cli:hover {
            background: #1e7e34;
        }
        .config-copy-feedback {
            display: inline-block;
            margin-left: 5px;
            color: #28a745;
            font-size: 11px;
            opacity: 0;
            transition: opacity 0.3s;
        }
        .config-copy-feedback.show {
            opacity: 1;
        }
    `;

    // Add styles to page
    var styleSheet = document.createElement("style");
    styleSheet.textContent = styles;
    document.head.appendChild(styleSheet);

    // Function to copy text to clipboard
    function copyToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function() {
                console.log('Copied to clipboard:', text);
            }).catch(function(err) {
                console.error('Failed to copy:', err);
                fallbackCopy(text);
            });
        } else {
            fallbackCopy(text);
        }
    }

    // Fallback copy method for older browsers
    function fallbackCopy(text) {
        var textArea = document.createElement('textarea');
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
    }

    // Function to show copy feedback
    function showCopyFeedback(button) {
        var feedback = button.nextElementSibling;
        feedback.classList.add('show');
        setTimeout(function() {
            feedback.classList.remove('show');
        }, 2000);
    }

    // Function to extract config section from URL or form
    function getConfigSection() {
        var urlParams = new URLSearchParams(window.location.search);
        var section = urlParams.get('section');
        if (section) return section;

        // Fallback: try to extract from form structure
        var form = document.querySelector('form[data-ui-id*="config-form"]');
        if (form) {
            var action = form.getAttribute('action') || '';
            var match = action.match(/section\/([^\/]+)/);
            if (match) return match[1];
        }

        // Another fallback: extract from fieldset IDs
        var firstFieldset = document.querySelector('fieldset[id*="_"]');
        if (firstFieldset) {
            var id = firstFieldset.id;
            var parts = id.split('_');
            if (parts.length > 0) return parts[0];
        }

        return 'unknown_section';
    }

    // Function to parse field name and extract config path components
    function parseFieldName(fieldName) {
        // Example: groups[identity][fields][logo_html][value]
        console.log('=== PARSING DEBUG ===');
        console.log('Input field name:', fieldName);
        console.log('Field name type:', typeof fieldName);
        console.log('Field name length:', fieldName.length);

        // Alternative parsing method using indexOf for better compatibility
        var groupStart = fieldName.indexOf('groups[');
        var fieldsPattern = '][fields][';
        var fieldStart = fieldName.indexOf(fieldsPattern);

        console.log('Group start position:', groupStart);
        console.log('Fields pattern position:', fieldStart);

        if (groupStart !== -1 && fieldStart !== -1) {
            // Extract group name
            var groupBracketStart = groupStart + 7; // length of 'groups['
            var groupBracketEnd = fieldName.indexOf(']', groupBracketStart);
            var group = fieldName.substring(groupBracketStart, groupBracketEnd);

            // Extract field name
            var fieldBracketStart = fieldStart + fieldsPattern.length; // position after '][fields]['
            var nextBracket = fieldName.indexOf(']', fieldBracketStart);
            var field = fieldName.substring(fieldBracketStart, nextBracket);

            console.log('Group bracket start:', groupBracketStart, 'end:', groupBracketEnd);
            console.log('Field bracket start:', fieldBracketStart, 'next bracket:', nextBracket);
            console.log('Extracted group:', group);
            console.log('Extracted field:', field);

            if (group && field) {
                var result = {
                    group: group,
                    field: field
                };
                console.log('Final parsed result:', result);
                console.log('=== END PARSING DEBUG ===');
                return result;
            }
        }

        // Fallback to regex method
        try {
            console.log('Trying regex method...');
            var groupMatch = fieldName.match(/groups\[([^\]]+)\]/);
            var fieldMatch = fieldName.match(/\[fields\]\[([^\]]+)\]/);

            console.log('Group regex match:', groupMatch);
            console.log('Field regex match:', fieldMatch);

            if (groupMatch && fieldMatch) {
                var result = {
                    group: groupMatch[1],
                    field: fieldMatch[1]
                };
                console.log('Regex parsed result:', result);
                console.log('=== END PARSING DEBUG ===');
                return result;
            }
        } catch (e) {
            console.log('Regex error:', e);
        }

        console.log('Parse failed for:', fieldName);
        console.log('=== END PARSING DEBUG ===');
        return null;
    }

    // Function to get field value
    function getFieldValue(field) {
        var tagName = field.tagName.toLowerCase();

        switch (tagName) {
            case 'select':
                var selectedOption = field.querySelector('option:checked');
                return selectedOption ? selectedOption.value : '';
            case 'input':
                if (field.type === 'checkbox') {
                    return field.checked ? '1' : '0';
                }
                return field.value || '';
            case 'textarea':
                return field.value || '';
            default:
                return '';
        }
    }

    // Function to escape value for different formats
    function escapeValue(value, format) {
        if (format === 'cli') {
            // Escape for shell command
            return value.replace(/"/g, '\\"');
        } else {
            // Escape for PHP array
            return value.replace(/'/g, "\\'");
        }
    }

    // Function to create copy buttons for a field
    function createCopyButtons(field) {
        var fieldName = field.getAttribute('name');
        if (!fieldName) return;

        // Skip inherit checkboxes - we only want actual config values, not inheritance controls
        if (fieldName.indexOf('[inherit]') !== -1) {
            console.log('Skipping inherit field:', fieldName);
            return;
        }

        var pathComponents = parseFieldName(fieldName);
        if (!pathComponents) return;

        var section = getConfigSection();
        var configPath = section + '/' + pathComponents.group + '/' + pathComponents.field;
        var value = getFieldValue(field);

        console.log('Creating buttons for path:', configPath, 'value:', value);

        // Create button container
        var buttonContainer = document.createElement('div');
        buttonContainer.style.display = 'inline-block';
        buttonContainer.style.marginLeft = '10px';

        // CLI format button
        var cliButton = document.createElement('button');
        cliButton.textContent = 'CLI';
        cliButton.className = 'config-copy-btn cli';
        cliButton.title = 'Copy as CLI command';
        cliButton.onclick = function(e) {
            e.preventDefault();
            var escapedValue = escapeValue(value, 'cli');
            var cliCommand = 'magento config:set "' + configPath + '" "' + escapedValue + '"';
            copyToClipboard(cliCommand);
            showCopyFeedback(cliButton);
        };

        // Config.php format button
        var configButton = document.createElement('button');
        configButton.textContent = 'PHP';
        configButton.className = 'config-copy-btn';
        configButton.title = 'Copy as config.php format';
        configButton.onclick = function(e) {
            e.preventDefault();
            var escapedValue = escapeValue(value, 'php');
            var configFormat = "'" + configPath + "' => '" + escapedValue + "',";
            copyToClipboard(configFormat);
            showCopyFeedback(configButton);
        };

        // Feedback elements
        var cliFeedback = document.createElement('span');
        cliFeedback.className = 'config-copy-feedback';
        cliFeedback.textContent = 'Copied!';

        var configFeedback = document.createElement('span');
        configFeedback.className = 'config-copy-feedback';
        configFeedback.textContent = 'Copied!';

        // Append elements
        buttonContainer.appendChild(cliButton);
        buttonContainer.appendChild(cliFeedback);
        buttonContainer.appendChild(configButton);
        buttonContainer.appendChild(configFeedback);

        // Find the best place to insert the buttons
        var valueCell = field.closest('td');
        if (valueCell) {
            valueCell.appendChild(buttonContainer);
        }
    }

    // Function to process all config fields
    function processConfigFields() {
        console.log('Processing config fields...');

        // Find all config input fields
        var selectors = [
            'select[name*="groups"][name*="fields"]',
            'input[name*="groups"][name*="fields"]',
            'textarea[name*="groups"][name*="fields"]'
        ];

        for (var i = 0; i < selectors.length; i++) {
            var selector = selectors[i];
            console.log('Processing selector:', selector);
            var fields = document.querySelectorAll(selector);
            console.log('Found fields:', fields.length);

            for (var j = 0; j < fields.length; j++) {
                var field = fields[j];
                console.log('Processing field:', field.name);

                // Skip if buttons already added
                var parent = field.closest('td');
                if (parent && !parent.querySelector('.config-copy-btn')) {
                    createCopyButtons(field);
                }
            }
        }
    }

    // Function to observe for dynamic content changes
    function observeChanges() {
        var observer = new MutationObserver(function(mutations) {
            var shouldProcess = false;
            for (var i = 0; i < mutations.length; i++) {
                var mutation = mutations[i];
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    shouldProcess = true;
                    break;
                }
            }
            if (shouldProcess) {
                setTimeout(processConfigFields, 100);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // Initialize when page is ready
    function init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function() {
                setTimeout(processConfigFields, 500);
                observeChanges();
            });
        } else {
            setTimeout(processConfigFields, 500);
            observeChanges();
        }
    }

    // Add a refresh button to manually trigger the script
    function addRefreshButton() {
        var refreshButton = document.createElement('button');
        refreshButton.textContent = '🔄 Refresh Copy Buttons';
        refreshButton.style.cssText =
            'position: fixed;' +
            'top: 10px;' +
            'right: 10px;' +
            'z-index: 9999;' +
            'background: #ff6900;' +
            'color: white;' +
            'border: none;' +
            'padding: 8px 12px;' +
            'border-radius: 4px;' +
            'cursor: pointer;' +
            'font-size: 12px;';

        refreshButton.onclick = function() {
            // Remove existing buttons first
            var existingButtons = document.querySelectorAll('.config-copy-btn');
            for (var i = 0; i < existingButtons.length; i++) {
                var btn = existingButtons[i];
                if (btn.parentNode) {
                    btn.parentNode.remove();
                }
            }
            processConfigFields();
        };
        document.body.appendChild(refreshButton);
    }

    // Start the script
    init();
    addRefreshButton();

    console.log('Magento 2 Config Copy Helper loaded!');
})();