"use strict";

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying ChainFS with account:", deployer.address);

  const ChainFS = await hre.ethers.getContractFactory("ChainFS");
  const chainfs = await ChainFS.deploy();
  await chainfs.waitForDeployment();

  const address = await chainfs.getAddress();
  console.log("ChainFS deployed to:", address);
  console.log("Set CHAINFS_CONTRACT=" + address);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
