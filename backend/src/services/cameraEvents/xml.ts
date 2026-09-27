import { XMLParser } from 'fast-xml-parser';

/**
 * XML parsing for camera protocols (fast-xml-parser, MIT, all dependencies MIT). Namespace
 * prefixes are removed; attributes are grouped under '$' and element text beside attributes
 * under '_'; repeated elements become arrays. Values stay strings (no number coercion, which
 * would corrupt tokens such as "0123").
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  attributeNamePrefix: '',
  attributesGroupName: '$',
  textNodeName: '_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
});

export async function parseXml(xml: string): Promise<any> {
  // Camera protocols never use DTDs; refusing them removes entity-expansion attacks entirely.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML with a DOCTYPE/ENTITY declaration is refused');
  const doc = parser.parse(xml, true);
  if (!doc || typeof doc !== 'object') throw new Error('not an XML document');
  return doc;
}
