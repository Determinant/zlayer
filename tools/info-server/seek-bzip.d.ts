declare module 'seek-bzip' {
  const bzip: { decode(input: Uint8Array, output: { writeByte(value: number): void }): void };
  export default bzip;
}
