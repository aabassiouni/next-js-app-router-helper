/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from "vscode";
import * as fs from "graceful-fs"; // using graceful-fs to avoid EMFILE errors
import * as nodepath from "path";
import * as babel from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import { ImportDeclaration, Directive, File } from "@babel/types";

const isClientComponentCache: Record<string, boolean> = {};
const checkingStack: string[] = [];

function getTsConfigPathAliases(): Record<string, string> {
    if (!vscode?.workspace?.workspaceFolders?.length) {
        return {};
    }
    const tsConfigPath = nodepath.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "tsconfig.json");
    try {
        const tsConfigContents = fs.readFileSync(tsConfigPath, "utf-8");
        const tsConfig = JSON.parse(tsConfigContents);
        const baseUrl = tsConfig?.compilerOptions?.baseUrl || ".";
        const paths = tsConfig?.compilerOptions?.paths || {};

        const aliases: Record<string, string> = {};
        for (const alias in paths) {
            aliases[alias] = nodepath.resolve(
                vscode.workspace.workspaceFolders[0].uri.fsPath,
                baseUrl,
                paths[alias][0]
            );
        }

        return aliases;
    } catch (error) {
        console.error("Could not read tsconfig.json", error);
        return {};
    }
}

const aliases = getTsConfigPathAliases();

//check all components in the project
async function scanProjectForClientComponents(folderPath: string): Promise<void> {
    const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });

    for (const entry of entries) {
        try {
            const fullEntryPath = nodepath.join(folderPath, entry.name);
            if (fullEntryPath.includes(`/pages/`)) {
                continue;
            }

            if (entry.isDirectory()) {
                await scanProjectForClientComponents(fullEntryPath);
            } else if (entry.isFile() && (entry.name.endsWith(".tsx") || entry.name.endsWith(".jsx"))) {
                await isClientComponent(fullEntryPath);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Error while scanning ${entry.name}: ${error}`);
        }
    }
}

//check for client directive in component
async function isClientComponent(filePath: string): Promise<boolean> {
    //mark component and all its imports as client components
    async function markComponentAsClient(filePath: string, astProp?: babel.ParseResult<File>) {
        if (checkingStack.includes(filePath)) {
            return;
        }

        if (!checkingStack.includes(filePath)) {
            checkingStack.push(filePath);
            isClientComponentCache[filePath] = true;
        }

        let ast;

        if (!astProp) {
            const code = fs.readFileSync(filePath, "utf-8");
            ast = babel.parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });
        } else {
            ast = astProp;
        }

        traverse(ast, {
            ImportDeclaration(path: NodePath<ImportDeclaration>) {
                if (path.node.importKind === "type") {
                    return; // Skip over TypeScript type imports
                }

                let source = path.node.source.value;

                if (source.startsWith(".")) {
                    const fullSourcePath = nodepath.resolve(nodepath.dirname(filePath), source) + ".tsx";
                    markComponentAsClient(fullSourcePath);
                }

                if (source.startsWith("/")) {
                    const fullSourcePath = nodepath.resolve(nodepath.dirname(filePath), source) + ".tsx";
                    markComponentAsClient(fullSourcePath);
                }

                for (const alias in aliases) {
                    // check if import is using an alias from tsconfig.json
                    const test = alias.replace(/\/\*/, ""); // some fun regex things to remove the * from the end of the alias
                    if (source.startsWith(alias.replace(/\/\*/, ""))) {
                        const newSource = source.replace(alias.replace(/\/\*/, ""), aliases[alias].replace("*", ""));
                        const fullSourcePath = nodepath.resolve(nodepath.dirname(filePath), newSource) + ".tsx";
                        markComponentAsClient(fullSourcePath);
                        break;
                    }
                }
            },
        });

        checkingStack.splice(checkingStack.indexOf(filePath), 1);
    }

    if (filePath in isClientComponentCache) {
        return isClientComponentCache[filePath];
    }

    const code = await fs.promises.readFile(filePath, "utf-8");
    const ast = babel.parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });

    let containsClientDirective = false;

    traverse(ast, {
        Directive(path: NodePath<Directive>) {
            const directive = path.node.value.value;
            if (directive === "use client") {
                containsClientDirective = true;
                path.stop();
            }
        },
    });

    if (containsClientDirective) {
        markComponentAsClient(filePath, ast);
    } else {
        isClientComponentCache[filePath] = false;
    }

    return isClientComponentCache[filePath];
}

function checkIfNextProject() {
    try {
        const packageJson = JSON.parse(fs.readFileSync(vscode.workspace.rootPath + "/package.json").toString());
        const nextVersion = packageJson.dependencies?.next || packageJson.devDependencies?.next;

        if (!nextVersion) {
            vscode.window.showErrorMessage("Not a Next.js project");
            return false;
        } else {
            return true;
        }
    } catch {
        vscode.window.showErrorMessage("Could not find package.json");
        return false;
    }
}

export async function activate(context: vscode.ExtensionContext) {
    if (!vscode?.workspace?.workspaceFolders?.length) {
        return;
    }

    const isNextProject = checkIfNextProject();

    if (!isNextProject) {
        return;
    }

    const projectFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    statusBarItem.text = "Scanning project for client components...";

    scanProjectForClientComponents(projectFolder)
        .then(() => {
            vscode.window.showInformationMessage("Scan complete!");
            updateStatusBarItem(vscode.window.activeTextEditor);
        })
        .catch((error) => {
            console.error("Error during project scan", error);
        });

    const updateStatusBarItem = (editor: vscode.TextEditor | undefined) => {
        if (editor) {
            const filePath = editor.document.fileName;
            if (filePath in isClientComponentCache) {
                const componentType = isClientComponentCache[filePath] ? "Client" : "Server";
                statusBarItem.text = `${componentType} Component`;
                statusBarItem.command = "extension.scan";
                statusBarItem.show();
            } else {
                statusBarItem.text = "Not a component";
            }
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("extension.scan", async () => {
            if (!isNextProject) {
                return;
            }

            await scanProjectForClientComponents(projectFolder);
        })
    );

    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatusBarItem));
}

export function deactivate() {}
