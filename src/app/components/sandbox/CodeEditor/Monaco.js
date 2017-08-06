// @flow
import React from 'react';
import CodeMirror from 'codemirror';
import MonacoEditor from 'react-monaco-editor';
import styled from 'styled-components';
import { debounce } from 'lodash';
import type { Preferences, ModuleError, Module, Directory } from 'common/types';
import { getModulePath } from 'app/store/entities/sandboxes/modules/selectors';

import theme from 'common/theme';

import SyntaxHighlightWorker from 'worker-loader!./monaco/syntax-highlighter.js';
import LinterWorker from 'worker-loader!./monaco/linter';

import enableEmmet from './monaco/enable-emmet';
import fetchDependencyTypings from './monaco/fetch-dependency-typings';
import Header from './Header';

let modelCache = {};

type Props = {
  code: ?string,
  errors: ?Array<ModuleError>,
  id: string,
  sandboxId: string,
  title: string,
  modulePath: string,
  changeCode: (id: string, code: string) => Object,
  saveCode: () => void,
  canSave: boolean,
  preferences: Preferences,
  onlyViewMode: boolean,
  modules: Array<Module>,
  directories: Array<Directory>,
  dependencies: ?Object,
};

const Container = styled.div`
  width: 100%;
  height: 100%;
  overflow: hidden;
  z-index: 30;
`;

const fontFamilies = (...families) =>
  families
    .filter(Boolean)
    .map(
      family => (family.indexOf(' ') !== -1 ? JSON.stringify(family) : family),
    )
    .join(', ');

const CodeContainer = styled.div`
  position: relative;
  overflow: hidden;
  width: 100%;
  height: 100%;
  z-index: 30;

  .margin-view-overlays {
    background: ${theme.background2()};
  }

  .monaco-editor.vs-dark .monaco-editor-background {
    background: ${theme.background2()};
  }

  .mtk5 {
    color: #99c794 !important;
  }
  .mtk12.PropertyAssignment {
    color: #99c794;
  }
  .mtk12.PropertyAssignment.PropertyAccessExpression {
    color: #fac863;
  }
  .mtk12.Identifier.JsxOpeningElement {
    color: #ec5f67;
  }
  .mtk12.Identifier.JsxExpression.JsxClosingElement {
    color: #ec5f67;
  }
  .mtk12.Identifier.JsxClosingElement {
    color: #ec5f67 !important;
  }
  .mtk12.Identifier.JsxSelfClosingElement {
    color: #ec5f67;
  }
  .mtk12.Identifier.VariableStatement.JsxClosingElement {
    color: #ec5f67 !important;
  }
  .mtk12.VariableStatement.JsxSelfClosingElement.Identifier {
    color: #ec5f67;
  }
  .mtk12.Identifier.JsxAttribute.VariableDeclaration {
    color: #aa759f;
  }
  .mtk12.JsxExpression.VariableStatement {
    color: #fac863;
  }
  .mtk12.VariableStatement.JsxSelfClosingElement {
    color: #e0e0e0;
  }
  .mtk12.VariableStatement.JsxClosingElement {
    color: #e0e0e0;
  }
  .mtk12.JsxElement.JsxText {
    color: #e0e0e0;
  }
  .JsxText {
    color: #e0e0e0;
  }

  .Identifier.CallExpression
    + .OpenParenToken.CallExpression
    + .Identifier.CallExpression {
    color: #fac863 !important;
  }
`;

const handleError = (
  monaco,
  editor,
  currentErrors: ?Array<ModuleError>,
  nextErrors: ?Array<ModuleError>,
  nextCode: ?string,
  prevId: string,
  nextId: string,
) => {
  if (!monaco) return;
  if (nextErrors && nextErrors.length > 0) {
    nextErrors.forEach(error => {
      const code = nextCode || '';
      if (
        error &&
        (error.moduleId == null || error.moduleId === nextId) &&
        error.line !== 0 &&
        error.line <= code.split('\n').length
      ) {
        monaco.editor.setModelMarkers(editor.getModel(), 'error', [
          {
            severity: monaco.Severity.Error,
            startColumn: 1,
            startLineNumber: error.line,
            endColumn: error.column,
            endLineNumber: error.line + 1,
            message: error.message,
          },
        ]);
      }
    });
  } else {
    monaco.editor.setModelMarkers(editor.getModel(), 'error', []);
  }
};

export default class CodeEditor extends React.PureComponent {
  props: Props;

  constructor(props: Props) {
    super(props);

    this.syntaxWorker = new SyntaxHighlightWorker();
    this.lintWorker = new LinterWorker();

    this.lint = debounce(this.lint, 400);

    this.syntaxWorker.addEventListener('message', event => {
      const { classifications, version } = event.data;

      if (version === this.editor.getModel().getVersionId()) {
        this.updateDecorations(classifications);
      }
    });

    this.lintWorker.addEventListener('message', event => {
      const { markers, version } = event.data;

      if (version === this.editor.getModel().getVersionId()) {
        this.updateLintWarnings(markers);
      }
    });
  }

  updateDecorations = (classifications: Array<Object>) => {
    const decorations = classifications.map(classification => ({
      range: new this.monaco.Range(
        classification.startLine,
        classification.start,
        classification.endLine,
        classification.end,
      ),
      options: {
        inlineClassName: classification.kind,
      },
    }));

    const modelInfo = this.getModelById(this.props.id);

    modelInfo.decorations = this.editor.deltaDecorations(
      modelInfo.decorations || [],
      decorations,
    );
  };

  updateLintWarnings = (markers: Array<Object>) => {
    this.monaco.editor.setModelMarkers(
      this.editor.getModel(),
      'eslint',
      markers,
    );
  };

  shouldComponentUpdate(nextProps: Props) {
    if (nextProps.modules !== this.props.modules) {
      // First check for path updates;
      nextProps.modules.forEach(module => {
        if (modelCache[module.id] && modelCache[module.id].model) {
          const { modules, directories } = nextProps;
          const path = '.' + getModulePath(modules, directories, module.id);

          // Check for changed path, if that's
          // the case create a new model with corresponding tag, ditch the other model
          if (path !== modelCache[module.id].model.uri.path) {
            const isCurrentlyOpened =
              this.editor.getModel() === modelCache[module.id].model;

            if (isCurrentlyOpened) {
              // Unload model, we're going to dispose it
              this.editor.setModel(null);
            }

            modelCache[module.id].model.dispose();
            delete modelCache[module.id];

            const newModel = this.createModel(
              module,
              nextProps.modules,
              nextProps.directories,
            );

            if (isCurrentlyOpened) {
              // Open it again if it was open
              this.editor.setModel(newModel);
            }
          }
        } else {
          // Model doesn't exist!!
          this.createModel(module, nextProps.modules, nextProps.directories);
        }
      });

      // Also check for deleted modules
      Object.keys(modelCache).forEach(moduleId => {
        // This module got deleted, dispose it
        if (!nextProps.modules.find(m => m.id === moduleId)) {
          modelCache[moduleId].model.dispose();
          delete modelCache[moduleId];
        }
      });
    }

    const { preferences } = this.props;
    const { preferences: nextPref } = nextProps;

    if (
      preferences.fontFamily !== nextPref.fontFamily ||
      preferences.fontSize !== nextPref.fontSize ||
      preferences.lineHeight !== nextPref.lineHeight
    ) {
      this.editor.updateOptions(this.getEditorOptions());
    }

    const { dependencies } = this.props;
    const { dependencies: nextDependencies } = nextProps;

    // Fetch new dependencies if added
    if (
      nextDependencies != null &&
      dependencies != null &&
      Object.keys(dependencies).join('') !==
        Object.keys(nextDependencies).join('')
    ) {
      fetchDependencyTypings(nextDependencies, this.monaco);
    }

    return (
      nextProps.sandboxId !== this.props.sandboxId ||
      nextProps.id !== this.props.id ||
      nextProps.errors !== this.props.errors ||
      this.props.canSave !== nextProps.canSave ||
      this.props.preferences !== nextProps.preferences
    );
  }

  swapDocuments = async ({
    currentId,
    nextId,
    nextCode,
    nextTitle,
  }: {
    currentId: string,
    nextId: string,
    nextCode: ?string,
    nextTitle: string,
  }) => {
    if (nextId !== currentId) {
      this.openNewModel(nextId, nextTitle);
    }
  };

  componentWillUpdate(nextProps: Props) {
    const {
      id: currentId,
      sandboxId: currentSandboxId,
      errors: currentErrors,
    } = this.props;

    const {
      id: nextId,
      code: nextCode,
      errors: nextErrors,
      title: nextTitle,
      sandboxId: nextSandboxId,
    } = nextProps;

    if (nextSandboxId !== currentSandboxId) {
      // Reset models, dispose old ones
      this.disposeModules();

      // Do in a timeout, since disposing is async
      setTimeout(() => {
        // Initialize new models
        this.initializeModules(nextProps.modules);
      });
    } else {
      this.swapDocuments({
        currentId,
        nextId,
        nextCode,
        nextTitle,
      }).then(() => {
        handleError(
          this.monaco,
          this.editor,
          currentErrors,
          nextErrors,
          nextCode,
          currentId,
          nextId,
        );
      });
    }
  }

  updateCode(code: string = '') {
    const pos = this.editor.getPosition();
    const lines = this.editor.getModel().getLinesContent();
    const lastLine = lines.length;
    const lastLineColumn = lines[lines.length - 1].length;
    const editOperation = {
      identifier: {
        major: 0,
        minor: 0,
      },
      text: code,
      range: new this.monaco.Range(0, 0, lastLine, lastLineColumn),
      forceMoveMarkers: false,
    };

    this.editor.getModel().pushEditOperations([], [editOperation], null);
    this.editor.setPosition(pos);
  }

  getMode = (title: string) => {
    if (title == null) return 'typescript';

    const kind = title.match(/\.([^.]*)$/);

    if (kind) {
      if (kind[1] === 'css') {
        return 'css';
      } else if (kind[1] === 'html') {
        return 'html';
      } else if (kind[1] === 'md') {
        return 'markdown';
      }
    }

    return 'typescript';
  };

  syntaxHighlight = (code: string, title: string, version: string) => {
    if (this.getMode(title) === 'typescript') {
      this.syntaxWorker.postMessage({
        code,
        title,
        version,
      });
    }
  };

  lint = (code: string, title: string, version: string) => {
    if (this.getMode(title) === 'typescript') {
      this.lintWorker.postMessage({
        code,
        title,
        version,
      });
    }
  };

  handleChange = (newCode: string) => {
    this.props.changeCode(this.props.id, newCode);

    this.syntaxHighlight(
      newCode,
      this.props.title,
      this.editor.getModel().getVersionId(),
    );
    this.lint(newCode, this.props.title, this.editor.getModel().getVersionId());
  };

  editorWillMount = monaco => {
    monaco.editor.defineTheme('CodeSandbox', {
      base: 'vs-dark', // can also be vs-dark or hc-black
      inherit: true, // can also be false to completely replace the builtin rules
      rules: [
        { token: 'comment', foreground: '626466' },
        { token: 'keyword', foreground: '6CAEDD' },
        { token: 'identifier', foreground: 'fac863' },
      ],
    });
  };

  configureEditor = (editor, monaco) => {
    this.editor = editor;
    this.monaco = monaco;

    const compilerDefaults = {
      jsxFactory: 'React.createElement',
      reactNamespace: 'React',
      jsx: monaco.languages.typescript.JsxEmit.React,
      target: monaco.languages.typescript.ScriptTarget.ES2015,
      allowNonTsExtensions: true,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      module: monaco.languages.typescript.ModuleKind.System,
      experimentalDecorators: true,
      allowJs: true,
      noEmit: true,
    };

    monaco.languages.typescript.typescriptDefaults.setMaximunWorkerIdleTime(-1);
    monaco.languages.typescript.javascriptDefaults.setMaximunWorkerIdleTime(-1);
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions(
      compilerDefaults,
    );
    monaco.languages.typescript.javascriptDefaults.setCompilerOptions(
      compilerDefaults,
    );
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    });

    this.initializeModules();
    this.openNewModel(this.props.id, this.props.title);

    this.addKeyCommands();
    enableEmmet(editor, monaco, {});

    window.addEventListener('resize', this.resizeEditor);
    this.sizeProbeInterval = setInterval(this.resizeEditor.bind(this), 3000);

    if (this.props.dependencies) {
      fetchDependencyTypings(this.props.dependencies, monaco);
    }
  };

  addKeyCommands = () => {
    this.editor.addCommand(
      this.monaco.KeyMod.CtrlCmd | this.monaco.KeyCode.KEY_S,
      () => {
        this.handleSaveCode();
      },
    );
  };

  disposeModules = () => {
    this.editor.setModel(null);

    this.monaco.editor.getModels().forEach(model => {
      model.dispose();
    });

    modelCache = {};
  };

  initializeModules = (modules = this.props.modules) => {
    modules.forEach(module => {
      this.createModel(module);
    });
  };

  resizeEditor = () => {
    this.editor.layout();
  };

  componentWillUnmount() {
    window.removeEventListener('resize', this.resizeEditor);
    this.disposeModules();
    this.editor.dispose();
    this.syntaxWorker.terminate();
    this.lintWorker.terminate();
    clearTimeout(this.sizeProbeInterval);
  }

  createModel = (
    module: Module,
    modules: Array<Module> = this.props.modules,
    directories: Array<Directory> = this.props.directories,
  ) => {
    const path = '.' + getModulePath(modules, directories, module.id);

    const model = this.monaco.editor.createModel(
      module.code,
      this.getMode(module.title),
      new this.monaco.Uri().with({ path }),
    );

    modelCache[module.id] = modelCache[module.id] || {
      model: null,
      decorations: [],
      cursorPos: null,
    };
    modelCache[module.id].model = model;

    return model;
  };

  getModelById = (id: string) => {
    const { modules } = this.props;
    if (!modelCache[id]) {
      const module = modules.find(m => m.id === id);

      this.createModel(module);
    }

    return modelCache[id];
  };

  openNewModel = (id: string, title: string) => {
    const modelInfo = this.getModelById(id);
    this.editor.setModel(modelInfo.model);

    this.syntaxHighlight(
      modelInfo.model.getValue(),
      title,
      modelInfo.model.getVersionId(),
    );
    this.lint(
      modelInfo.model.getValue(),
      title,
      modelInfo.model.getVersionId(),
    );
  };

  getCode = () => this.editor.getValue();

  prettify = async () => {
    const { id, title, preferences } = this.props;
    const code = this.getCode();
    const mode = this.getMode(title);

    if (mode === 'typescript' || mode === 'css') {
      try {
        const prettify = await import('app/utils/codemirror/prettify');
        const newCode = await prettify.default(
          code,
          mode === 'typescript' ? 'jsx' : mode,
          preferences.lintEnabled,
          preferences.prettierConfig,
        );

        if (newCode !== code) {
          this.props.changeCode(id, newCode);
          this.updateCode(newCode);
        }
      } catch (e) {
        console.error(e);
      }
    }
  };

  handleSaveCode = async () => {
    const { saveCode, preferences } = this.props;
    if (preferences.prettifyOnSaveEnabled) {
      await this.prettify();
    }
    const { id } = this.props;
    this.props.changeCode(id, this.getCode());
    saveCode();
  };

  getEditorOptions = () => {
    const { preferences } = this.props;
    return {
      selectOnLineNumbers: true,
      fontSize: preferences.fontSize,
      fontFamily: fontFamilies(
        preferences.fontFamily,
        'Source Code Pro',
        'monospace',
      ),
      lineHeight: (preferences.lineHeight || 1.15) * preferences.fontSize,
    };
  };

  render() {
    const { canSave, onlyViewMode, modulePath } = this.props;

    const options = this.getEditorOptions();

    const requireConfig = {
      url: '/public/vs/loader.js',
      paths: {
        vs: '/public/vs',
      },
    };

    return (
      <Container>
        <Header
          saveComponent={canSave && !onlyViewMode && this.handleSaveCode}
          prettify={!onlyViewMode && this.prettify}
          path={modulePath}
        />
        <CodeContainer>
          <MonacoEditor
            width="100%"
            height="100%"
            language="javascript"
            theme="CodeSandbox"
            options={options}
            requireConfig={requireConfig}
            editorDidMount={this.configureEditor}
            editorWillMount={this.editorWillMount}
            onChange={this.handleChange}
          />
        </CodeContainer>
      </Container>
    );
  }
}