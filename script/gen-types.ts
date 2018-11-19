import fs from "fs";
import path from "path";
import { prettyPrint } from "recast";
import typesModuleFn, { NameType } from "../lib/types";
import astTypes from "../main";

const { getBuilderName } = typesModuleFn();
const { builders: b, namedTypes: n } = astTypes;

const RESERVED: { [reserved: string]: boolean | undefined } = { "extends": true, "default": true };

const supertypeToSubtypes: { [supertypeName: string]: string[] } = {};
Object.keys(astTypes.namedTypes).map(typeName => {
  astTypes.Type.def(typeName).supertypeList.forEach(supertypeName => {
    supertypeToSubtypes[supertypeName] = supertypeToSubtypes[supertypeName] || [];
    supertypeToSubtypes[supertypeName].push(typeName);
  });
});

function referenceForType(type: string): string {
  return !supertypeToSubtypes[type] || supertypeToSubtypes[type].length === 0
    ? type
    : `${type}Kind`;
}

function resolveName(name: NameType): string {
  return typeof name === "function" ? name() : name;
}

function getTypeAnnotation(type: string): any {
  if (type === "null") {
    return b.tsNullKeyword();
  }
  if (type === "string") {
    return b.tsStringKeyword();
  }
  if (type === "boolean") {
    return b.tsBooleanKeyword();
  }
  if (type === "true" || type === "false") {
    return b.tsLiteralType.from({
      literal: b.booleanLiteral.from({
        value: type === "true",
      }),
    });
  }
  if (type === "number" || /^number [<>=]+ \d+$/.test(type)) {
    return b.tsNumberKeyword();
  }

  if (type[0] === "[" && type[type.length - 1] === "]") {
    // TODO `split(', ')`?
    const elemType = type.substring(1, type.length - 1);

    const elemTypeAnnotation = getTypeAnnotation(elemType);
    if (n.TSUnionType.check(elemTypeAnnotation)) {
      return b.tsArrayType.from({
        elementType: b.tsParenthesizedType.from({
          typeAnnotation: elemTypeAnnotation,
        }),
      });
    }

    return b.tsArrayType(elemTypeAnnotation);
  }

  if (type[0] === "{" && type[type.length - 1] === "}") {
    return b.tsTypeLiteral.from({
      members: type
        .substring(1, type.length - 1)
        .split(", ")
        .map(elem => {
          const [elemName, elemType] = elem.split(": ").map(str => str.trim());
          return getPropertySignature(elemName, elemType);
        }),
    });
  }

  if (type.indexOf(" | ") !== -1) {
    return b.tsUnionType.from({
      // TODO unique?
      types: type.split(" | ").map(elemType => getTypeAnnotation(elemType)),
    });
  }

  if (/^[A-Z]/.test(type)) {
    return b.tsTypeReference.from({
      typeName: b.identifier(referenceForType(type)),
    });
  }

  return b.tsLiteralType(b.stringLiteral(type));
}

function getPropertySignature(name: string, type: string, optional: boolean = false) {
  return b.tsPropertySignature.from({
    key: b.identifier(name),
    typeAnnotation: b.tsTypeAnnotation.from({
      typeAnnotation: getTypeAnnotation(type),
    }),
    optional: optional || /(^|\| )null( \||$)/.test(type),
  });
}

const builderTypeNames = Object.keys(astTypes.namedTypes).filter(typeName => {
  const typeDef = astTypes.Type.def(typeName);
  const builderName = getBuilderName(typeName);

  return !!typeDef.buildParams && !!astTypes.builders[builderName];
});

const declareModule = (name: string, body: any[]) =>
  b.file.from({
    program: b.program.from({
      body: [
        b.tsModuleDeclaration.from({
          id: b.stringLiteral(name),
          declare: true,
          body: b.tsModuleBlock.from({ body }),
        }),
      ],
    }),
  });

const out = [
  {
    file: "kinds.d.ts",
    ast: declareModule(
      "ast-types/lib/types",
      Object.keys(supertypeToSubtypes).map(baseName => {
        return b.tsTypeAliasDeclaration.from({
          id: b.identifier(`${baseName}Kind`),
          typeAnnotation: b.tsUnionType(
            supertypeToSubtypes[baseName].map(subtypeName =>
              b.tsTypeReference(b.identifier(subtypeName))
            )
          ),
        });
      })
    ),
  },
  {
    file: "nodes.d.ts",
    ast: declareModule(
      "ast-types/lib/types",
      Object.keys(astTypes.namedTypes).map(typeName => {
        const typeDef = astTypes.Type.def(typeName);
        return b.tsInterfaceDeclaration.from({
          id: b.identifier(typeName),
          extends: [
            b.tsExpressionWithTypeArguments.from({
              expression: b.identifier("ASTNode"),
            }),
          ],
          body: b.tsInterfaceBody.from({
            body: typeDef.fieldNames.map(fieldName => {
              const field = typeDef.allFields[fieldName];
              const fieldType = resolveName(field.type.name);

              if (fieldName === "type") {
                return b.tsPropertySignature.from({
                  key: b.identifier(fieldName),
                  typeAnnotation: b.tsTypeAnnotation(b.tsLiteralType(b.stringLiteral(typeName))),
                });
              }

              return getPropertySignature(fieldName, fieldType);
            }),
          }),
        });
      })
    ),
  },
  {
    file: "namedTypes.d.ts",
    ast: declareModule("ast-types/lib/types", [
      b.tsInterfaceDeclaration.from({
        id: b.identifier("NamedTypes"),
        body: b.tsInterfaceBody.from({
          body: Object.keys(astTypes.namedTypes).map(typeName => {
            return b.tsPropertySignature.from({
              key: b.identifier(typeName),
              typeAnnotation: b.tsTypeAnnotation.from({
                typeAnnotation: b.tsTypeReference.from({
                  typeName: b.identifier("Type"),
                  typeParameters: b.tsTypeParameterInstantiation([
                    b.tsTypeReference(b.identifier(typeName)),
                  ]),
                }),
              }),
            });
          }),
        }),
      }),
    ]),
  },
  {
    file: "builders.d.ts",
    ast: declareModule("ast-types/lib/types", [
      ...builderTypeNames.map(typeName => {
        const typeDef = astTypes.Type.def(typeName);

        const returnType = b.tsTypeAnnotation.from({
          typeAnnotation: b.tsTypeReference.from({
            typeName: b.identifier(typeName),
          }),
        });

        const buildParamAllowsUndefined: { [buildParam: string]: boolean } = {};
        const buildParamIsOptional: { [buildParam: string]: boolean } = {};
        [...typeDef.buildParams].reverse().forEach((cur, i, arr) => {
          const field = typeDef.allFields[cur];
          if (field && field.defaultFn) {
            if (i === 0) {
              buildParamIsOptional[cur] = true;
            } else {
              if (buildParamIsOptional[arr[i - 1]]) {
                buildParamIsOptional[cur] = true;
              } else {
                buildParamAllowsUndefined[cur] = true;
              }
            }
          }
        });

        return b.tsInterfaceDeclaration.from({
          id: b.identifier(`${typeName}Builder`),
          body: b.tsInterfaceBody.from({
            body: [
              b.tsCallSignatureDeclaration.from({
                parameters: typeDef.buildParams
                  .filter(buildParam => !!typeDef.allFields[buildParam])
                  .map(buildParam => {
                    const field = typeDef.allFields[buildParam];
                    const fieldTypeName = resolveName(field.type.name);
                    const name = RESERVED[buildParam] ? `${buildParam}Param` : buildParam;

                    return b.identifier.from({
                      name,
                      typeAnnotation: b.tsTypeAnnotation(
                        !!buildParamAllowsUndefined[buildParam]
                          ? b.tsUnionType([
                              getTypeAnnotation(fieldTypeName),
                              b.tsUndefinedKeyword(),
                            ])
                          : getTypeAnnotation(fieldTypeName)
                      ),
                      optional: !!buildParamIsOptional[buildParam],
                    });
                  }),
                typeAnnotation: returnType,
              }),
              b.tsMethodSignature.from({
                key: b.identifier("from"),
                parameters: [
                  b.identifier.from({
                    name: "params",
                    typeAnnotation: b.tsTypeAnnotation.from({
                      typeAnnotation: b.tsTypeLiteral.from({
                        members: typeDef.fieldNames
                          .filter(fieldName => fieldName !== "type")
                          .map(fieldName => {
                            const field = typeDef.allFields[fieldName];
                            const fieldType = resolveName(field.type.name);
                            const optional = field.defaultFn != null;

                            return getPropertySignature(fieldName, fieldType, optional);
                          }),
                      }),
                    }),
                  }),
                ],
                typeAnnotation: returnType,
              }),
            ],
          }),
        });
      }),

      b.tsInterfaceDeclaration.from({
        id: b.identifier("Builders"),
        body: b.tsInterfaceBody.from({
          body: [
            ...builderTypeNames.map(typeName => {
              return b.tsPropertySignature.from({
                key: b.identifier(getBuilderName(typeName)),
                typeAnnotation: b.tsTypeAnnotation.from({
                  typeAnnotation: b.tsTypeReference.from({
                    typeName: b.identifier(`${typeName}Builder`),
                  }),
                }),
              });
            }),
            b.tsIndexSignature.from({
              parameters: [
                b.identifier.from({
                  name: "builderName",
                  typeAnnotation: b.tsTypeAnnotation(b.tsStringKeyword()),
                }),
              ],
              typeAnnotation: b.tsTypeAnnotation.from({ typeAnnotation: b.tsAnyKeyword() }),
            }),
          ],
        }),
      }),
    ]),
  },
  {
    file: "visitor.d.ts",
    ast: declareModule("ast-types/lib/path-visitor", [
      b.importDeclaration(
        [b.importSpecifier(b.identifier("NodePath"))],
        b.stringLiteral("ast-types/lib/node-path")
      ),
      b.tsInterfaceDeclaration(
        b.identifier("Visitor"),
        b.tsInterfaceBody([
          ...Object.keys(astTypes.namedTypes).map(typeName => {
            return b.tsMethodSignature.from({
              key: b.identifier(`visit${typeName}`),
              parameters: [
                b.identifier.from({
                  name: "path",
                  typeAnnotation: b.tsTypeAnnotation(b.tsTypeReference(b.identifier("NodePath"))),
                }),
              ],
              optional: true,
              typeAnnotation: b.tsTypeAnnotation(b.tsAnyKeyword()),
            });
          }),
        ])
      ),
    ]),
  },
];

out.forEach(({ file, ast }) => {
  fs.writeFileSync(
    path.resolve(__dirname, `../gen/${file}`),
    prettyPrint(ast, { tabWidth: 2, includeComments: true }).code,
  );
});
