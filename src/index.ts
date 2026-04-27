export {
	startHarper,
	setupHarperWithFixture,
	killHarper,
	teardownHarper,
	sendOperation,
	createHarperContext,
	OPERATIONS_API_PORT,
	DEFAULT_ADMIN_USERNAME,
	DEFAULT_ADMIN_PASSWORD,
	DEFAULT_STARTUP_TIMEOUT_MS,
	type StartHarperOptions,
	type HarperContext,
	type HarperTestContext,
	type StartedHarperTestContext,
	type ContextWithHarper,
} from './harperLifecycle.ts';

export {
	validateLoopbackAddressPool,
	getNextAvailableLoopbackAddress,
	releaseLoopbackAddress,
	releaseAllLoopbackAddressesForCurrentProcess,
} from './loopbackAddressPool.ts';

export { targz } from './targz.ts';

export {
	startCrlServer,
	stopCrlServer,
	stopOcspResponder,
	setupCrlServerWithCerts,
	setupOcspResponderWithCerts,
	type OcspResponderContext,
	type CrlServerContext,
} from './securityServices.ts';

export { generateOcspCertificates, type OcspCertificates, type OcspServerCerts } from './security/ocsp/generate-test-certs.ts';
export { generateCrlCertificates, type CrlCertificates } from './security/crl/generate-test-certs.ts';
export {
	generateEd25519KeyPair,
	createCertificate,
	createCRL,
	certToPem,
	crlToPem,
	makeCRLDistributionPointsExt,
	makeOCSPAIAExt,
	makeExtKeyUsageExt,
	signBasicOCSPResponse,
	OCSP_SIGNING_OID,
	CLIENT_AUTH_OID,
	type Ed25519KeyPair,
} from './security/certGenUtils.ts';
export { startOcspServer, stopOcspServer } from './security/ocspServer.ts';
