import { registry } from '@salesforce/source-deploy-retrieve';

import { textOf, type XmlCollectionRules } from '../xml.js';

type RegistryType = (typeof registry)['types'][string];

const getRegistryType = (typeName: string): RegistryType => {
  const type = Object.values(registry.types).find((candidate) => candidate.name === typeName);
  if (!type?.children) {
    throw new Error(`Metadata type ${typeName} has no child types in the SDR registry.`);
  }

  return type;
};

// Derive collection rules from the SDR registry so every child element (e.g. sharingCriteriaRules)
// is keyed by its unique id and mapped to the child type used in destructiveChanges.xml.
export const childCollectionRules = (typeName: string): XmlCollectionRules => {
  const type = getRegistryType(typeName);

  return Object.fromEntries(
    Object.values(type.children!.types)
      .filter((childType) => childType.xmlElementName)
      .map((childType) => {
        const uniqueIdElement = childType.uniqueIdElement ?? 'fullName';
        return [
          childType.xmlElementName!,
          {
            keySelector: (item: Record<string, unknown>) => textOf(item[uniqueIdElement]),
            supportsDelete: true,
            childType: childType.name,
          },
        ];
      })
  );
};

// Children of most nonDecomposed types are addressed as Parent.Child (Account.MyRule);
// CustomLabels is the exception because its parent fullName is not parsed from the file.
export const qualifiesChildNames = (typeName: string): boolean => !getRegistryType(typeName).ignoreParsedFullName;
