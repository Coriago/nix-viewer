import * as vscode from 'vscode';
import { logger } from './logger';

/**
 * Webview provider for the search input box.
 * Provides a persistent text input that filters the tree view in real-time.
 */
export class SearchViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'flakeSearch';

    private view?: vscode.WebviewView;
    private currentValue: string = '';
    private suggestions: string[] = [];

    private _onDidChangeSearch = new vscode.EventEmitter<string>();
    readonly onDidChangeSearch = this._onDidChangeSearch.event;

    constructor(private readonly extensionUri: vscode.Uri) { }

    /**
     * Called when the webview is created.
     */
    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };

        webviewView.webview.html = this.getHtmlContent();

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage((message) => {
            switch (message.type) {
                case 'search':
                    this.currentValue = message.value;
                    this._onDidChangeSearch.fire(message.value);
                    break;
                case 'clear':
                    this.currentValue = '';
                    this._onDidChangeSearch.fire('');
                    break;
                case 'selectSuggestion':
                    this.currentValue = message.value;
                    this._onDidChangeSearch.fire(message.value);
                    this.updateInputValue(message.value);
                    break;
            }
        });

        // Restore the current value when webview becomes visible
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible && this.currentValue) {
                this.updateInputValue(this.currentValue);
            }
        });
    }

    /**
     * Update the input value in the webview.
     */
    private updateInputValue(value: string): void {
        if (this.view) {
            this.view.webview.postMessage({
                type: 'setValue',
                value: value,
            });
        }
    }

    /**
     * Update the autocomplete suggestions.
     */
    updateSuggestions(suggestions: string[]): void {
        this.suggestions = suggestions;
        if (this.view) {
            this.view.webview.postMessage({
                type: 'suggestions',
                suggestions: suggestions,
            });
        }
    }

    /**
     * Get the current search value.
     */
    getValue(): string {
        return this.currentValue;
    }

    /**
     * Clear the search input.
     */
    clear(): void {
        this.currentValue = '';
        if (this.view) {
            this.view.webview.postMessage({ type: 'clear' });
        }
        this._onDidChangeSearch.fire('');
    }

    /**
     * Focus the search input.
     */
    focus(): void {
        if (this.view) {
            this.view.show(true);
            this.view.webview.postMessage({ type: 'focus' });
        }
    }

    /**
     * Generate the HTML content for the webview.
     */
    private getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * {
            box-sizing: border-box;
        }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            padding: 0;
            margin: 0;
        }
        .search-container {
            padding: 8px;
            position: relative;
        }
        .input-wrapper {
            position: relative;
            display: flex;
            align-items: center;
        }
        .search-icon {
            position: absolute;
            left: 8px;
            color: var(--vscode-input-placeholderForeground);
            pointer-events: none;
        }
        #searchInput {
            width: 100%;
            padding: 6px 28px 6px 28px;
            border: 1px solid var(--vscode-input-border, transparent);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 2px;
            outline: none;
            font-family: inherit;
            font-size: inherit;
        }
        #searchInput:focus {
            border-color: var(--vscode-focusBorder);
        }
        #searchInput::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }
        .clear-btn {
            position: absolute;
            right: 4px;
            background: none;
            border: none;
            color: var(--vscode-input-placeholderForeground);
            cursor: pointer;
            padding: 4px;
            display: none;
            align-items: center;
            justify-content: center;
            border-radius: 3px;
        }
        .clear-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
            color: var(--vscode-foreground);
        }
        .clear-btn.visible {
            display: flex;
        }
        .suggestions {
            position: absolute;
            top: 100%;
            left: 8px;
            right: 8px;
            background: var(--vscode-editorSuggestWidget-background);
            border: 1px solid var(--vscode-editorSuggestWidget-border);
            border-radius: 3px;
            max-height: 200px;
            overflow-y: auto;
            z-index: 1000;
            display: none;
            box-shadow: 0 2px 8px var(--vscode-widget-shadow);
        }
        .suggestions.visible {
            display: block;
        }
        .suggestion-item {
            padding: 4px 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .suggestion-item:hover,
        .suggestion-item.selected {
            background: var(--vscode-editorSuggestWidget-selectedBackground);
            color: var(--vscode-editorSuggestWidget-selectedForeground);
        }
        .suggestion-label {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .suggestion-path {
            font-size: 0.85em;
            opacity: 0.7;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .filter-info {
            padding: 4px 8px;
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            display: none;
        }
        .filter-info.visible {
            display: block;
        }
    </style>
</head>
<body>
    <div class="search-container">
        <div class="input-wrapper">
            <span class="search-icon">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M15.25 13.69l-4.06-4.06a5.5 5.5 0 10-1.56 1.56l4.06 4.06a1.1 1.1 0 001.56-1.56zM6.5 10.5a4 4 0 114-4 4 4 0 01-4 4z"/>
                </svg>
            </span>
            <input 
                type="text" 
                id="searchInput" 
                placeholder="Filter outputs (e.g., programs.git)"
                autocomplete="off"
                spellcheck="false"
            />
            <button class="clear-btn" id="clearBtn" title="Clear filter">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z"/>
                </svg>
            </button>
        </div>
        <div class="suggestions" id="suggestions"></div>
        <div class="filter-info" id="filterInfo"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const searchInput = document.getElementById('searchInput');
        const clearBtn = document.getElementById('clearBtn');
        const suggestionsEl = document.getElementById('suggestions');
        const filterInfo = document.getElementById('filterInfo');
        
        let suggestions = [];
        let selectedIndex = -1;
        let debounceTimer = null;

        // Debounced search
        function emitSearch(value) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                vscode.postMessage({ type: 'search', value: value });
            }, 150);
        }

        // Update clear button visibility
        function updateClearButton() {
            if (searchInput.value) {
                clearBtn.classList.add('visible');
            } else {
                clearBtn.classList.remove('visible');
            }
        }

        // Render suggestions
        function renderSuggestions() {
            if (suggestions.length === 0 || !searchInput.value) {
                suggestionsEl.classList.remove('visible');
                return;
            }

            suggestionsEl.innerHTML = suggestions.map((s, i) => {
                const parts = s.split('.');
                const label = parts[parts.length - 1];
                const path = parts.slice(0, -1).join('.');
                return \`
                    <div class="suggestion-item\${i === selectedIndex ? ' selected' : ''}" data-index="\${i}" data-value="\${s}">
                        <span class="suggestion-label">\${label}</span>
                        \${path ? \`<span class="suggestion-path">\${path}</span>\` : ''}
                    </div>
                \`;
            }).join('');

            suggestionsEl.classList.add('visible');
        }

        // Handle input
        searchInput.addEventListener('input', (e) => {
            updateClearButton();
            selectedIndex = -1;
            emitSearch(e.target.value);
        });

        // Handle keyboard navigation
        searchInput.addEventListener('keydown', (e) => {
            if (!suggestionsEl.classList.contains('visible')) {
                if (e.key === 'Escape') {
                    searchInput.value = '';
                    updateClearButton();
                    emitSearch('');
                }
                return;
            }

            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    selectedIndex = Math.min(selectedIndex + 1, suggestions.length - 1);
                    renderSuggestions();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    selectedIndex = Math.max(selectedIndex - 1, -1);
                    renderSuggestions();
                    break;
                case 'Enter':
                    e.preventDefault();
                    if (selectedIndex >= 0 && suggestions[selectedIndex]) {
                        selectSuggestion(suggestions[selectedIndex]);
                    }
                    suggestionsEl.classList.remove('visible');
                    break;
                case 'Escape':
                    suggestionsEl.classList.remove('visible');
                    selectedIndex = -1;
                    break;
                case 'Tab':
                    if (selectedIndex >= 0 && suggestions[selectedIndex]) {
                        e.preventDefault();
                        // Tab completes with a dot for drilling down
                        const value = suggestions[selectedIndex] + '.';
                        searchInput.value = value;
                        updateClearButton();
                        emitSearch(value);
                        selectedIndex = -1;
                    }
                    break;
            }
        });

        // Handle suggestion click
        suggestionsEl.addEventListener('click', (e) => {
            const item = e.target.closest('.suggestion-item');
            if (item) {
                selectSuggestion(item.dataset.value);
            }
        });

        function selectSuggestion(value) {
            searchInput.value = value;
            updateClearButton();
            suggestionsEl.classList.remove('visible');
            selectedIndex = -1;
            vscode.postMessage({ type: 'selectSuggestion', value: value });
        }

        // Handle clear button
        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            updateClearButton();
            suggestionsEl.classList.remove('visible');
            vscode.postMessage({ type: 'clear' });
            searchInput.focus();
        });

        // Hide suggestions when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.search-container')) {
                suggestionsEl.classList.remove('visible');
            }
        });

        // Handle messages from extension
        window.addEventListener('message', (event) => {
            const message = event.data;
            switch (message.type) {
                case 'suggestions':
                    suggestions = message.suggestions || [];
                    selectedIndex = -1;
                    renderSuggestions();
                    break;
                case 'setValue':
                    searchInput.value = message.value;
                    updateClearButton();
                    break;
                case 'clear':
                    searchInput.value = '';
                    updateClearButton();
                    suggestionsEl.classList.remove('visible');
                    break;
                case 'focus':
                    searchInput.focus();
                    break;
            }
        });

        // Focus input on load
        searchInput.focus();
    </script>
</body>
</html>`;
    }
}
