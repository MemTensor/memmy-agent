import type {RequestEnvelope} from "../../types.js";

/** The local management UI reads every stored owner without changing write identity. */
export function localPanelRequest<T extends RequestEnvelope>(input:T,local=true):T {
  if(!local)return input;
  const namespace=input.namespace?{...input.namespace}:undefined;
  if(namespace)delete namespace.userId;
  return {...input,userId:undefined,namespace};
}
